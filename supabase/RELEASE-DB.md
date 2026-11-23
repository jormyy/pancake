# Database releases

This runbook covers the database part of a release: order, rollback, incident controls, and queued SQL.
The [release runner guide](../scripts/release/README.md) covers the automated Mac release.

## How a database release runs

Database, then Edge, then merge the frontend.
Use this order unless the release order below names another one.

1. Confirm the production head with a read-only ledger dry run.
2. Apply the pending migrations with `supabase db push --linked --dry-run`, then `supabase db push --linked`.
3. Verify the new functions, grants, and data with read-only `supabase db query --linked` checks.
4. Deploy only the Edge functions that changed, and verify each one before the next step.
5. Merge the frontend through the supervisor.

Use the logged-in Supabase CLI for every database step.
The release planner must verify the applied prefix during an authorized rollout.
Each Edge release and each activation step needs its own authorization.
Regenerate database types, the function catalog, and release attestations from a fresh private database.
`supabase postgres-config` changes hosted Postgres settings.
The CLI cannot change the hosted PostgREST pool.
When a release changes that pool, Michael must set and confirm it through the dashboard before merge.
If the host refuses a setting, stop before the frontend merge.

Roll back Edge with the previous Edge source.
Never reverse database history.
Recover the database with a forward migration that restores the previous definition.
Do not unschedule a retired per-job cron. Cron calls `public.dispatch_work()` for all queued work.

## Release order for this release

The supplied production head is `20261214011300` (`trade_roster_holds`), with 791 migrations.
This release adds six migrations, for 797 migrations:
`20261214011400_league_roster_policies.sql`, `20261214011500_weekly_roster_floor.sql`, `20261214011600_league_auto_ir_schedule.sql`, `20261214011700_enable_official_league_roster_policy.sql`, `20261214011800_tipoff_mode_aware_completion.sql`, and `20261214011900_total_add_week.sql`.
Database, then Edge, then merge the frontend.
The frontend needs no release.

1. **Migrations.** Apply all five through the guarded dry run and push. They change no roster, lineup, dispatch, or notice. `floor_activated_at` and `ir_activated_at` stay NULL, so the floor defers and the league-wide Auto IR admission stays off. The shared `pre-tipoff` fingerprint keeps its old body, so applying the migrations reopens no open window. After activation, the official league and the other leagues never reopen each other's completed windows.
2. **`lineup-optimizer`.** Deploy the release build (successor of v61) and verify it. With both latches NULL it does nothing new.
3. **`process-waivers`.** Deploy the release build (successor of v77) and verify it. With both latches NULL the floor defers with `worker_pending` and awards nobody.
4. **Activation.** After both workers pass verification, Forge runs this once:
   ```sql
   SELECT private.activate_league_roster_policy('faab8d8f-6a60-4bbc-8f5d-44050b652cdd');
   ```
   It sets both latches, returns true, and touches only that league. A rerun changes nothing. Nothing else activates the policy.

Do not activate before both workers are live.
The migrated admission refuses an old worker's scoped claim with `PT409`, so the official league's pre-tipoff IR and starters wait.
After activation, a floor add or Auto IR move that would use room held by an accepted trade is checked immediately with `private.assert_accepted_trade_capacity`, and the run skips that team alone, so a held spot never rolls back the rest of the run.
Each pending trade a team has accepted is checked on its own against the projected roster, so overlapping offers never add their holds.
A transient IR failure never writes a durable member receipt. The work item retries with unchanged inputs.

Run `npm run test:db:autoset-tipoff-integration` first on a freshly migrated database. It needs an empty `public.leagues` table.

### Rollback

Roll back `process-waivers` and `lineup-optimizer` first, then clear both latches. Keep the gap short.

```sql
UPDATE private.league_roster_policies
   SET floor_activated_at = NULL, ir_activated_at = NULL
 WHERE league_id = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd';
```

During the gap, the old `process-waivers` v77 runs extra normal waiver drains on the `week_end` date only.
The old `lineup-optimizer` v61 makes no league-wide IR move, and `PT409` refuses its claim on the scoped `pre-tipoff-policy` window.
That wait is the accepted trade-off for never running the old worker against the official league's scoped window.
Read back the policy row. Both latches must be NULL.

```sql
SELECT league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at
  FROM private.league_roster_policies;
SELECT id, status, attempts, due_at, last_error FROM private.work_items
 WHERE kind IN ('roster-floor', 'pre-tipoff-policy') ORDER BY id DESC;
```

To stop the floor enqueues without a rollback, delete the policy row or clear both latches.
Activation readback: `SELECT private.league_auto_ir_all_members('faab8d8f-6a60-4bbc-8f5d-44050b652cdd');` must return true only after step 4.

## Worker incident controls

Replacing the Edge `dispatcher` does not pause the SQL scheduler or other workers.
Pause new scheduled work with the operator RPC:

```sql
SELECT public.set_worker_paused(true, 'Investigating database load');
```

Inspect the saved control and queue before you resume:

```sql
SELECT * FROM private.worker_controls;
SELECT * FROM public.work_dashboard();
SELECT * FROM public.retention_dashboard();
```

The pause does not cancel a statement that is already running.
Wait until existing workers finish or lose their leases.
Check failed work and invocation outcomes before you retry.
Keep dead items for diagnosis. Do not delete queue rows to hide a failure.
Resume only after you understand the cause and the relevant local checks pass:

```sql
SELECT public.set_worker_paused(false, 'Database checks pass');
SELECT * FROM public.work_dashboard();
```

Confirm that due work starts and failure counts stop growing.
Only the service role and the database owner can call `public.set_worker_paused`.

Unset the `LIVE_SNAPSHOT_BASE_URL` worker secret to return live ingestion to the database path on new invocations.
That does not switch phones. Phones return to database mode only through a client deployment or the Vercel switch.

## Next release

This SQL is not installed. It waits for these conditions:

- Drop `leagues.taxi_rule` after the deployed client and its rollback retire.
- Drop `standings.waiver_priority` after old Edge writers and their rollback window retire.
- Keep compatibility topics, the app-wide hint stream, and screen subscriptions until older clients and their rollback artifacts retire.
- Keep the Expo objects while the deployed Edge release or its rollback can use them.

To remove Expo storage, first ship an Edge release without Expo delivery, receipt polling, or legacy storage access.
Settle pending tickets and close that rollback window.
Then give the SQL below a new migration version after the repository head.
Keep it outside `supabase/migrations` until that release.
It requeues pending tickets, replaces the queue routines, and removes the legacy objects.
Then remove their canonical sources and catalog entries, and regenerate types.

```sql
DROP TRIGGER IF EXISTS normalize_legacy_push_token_write ON public.profiles;
DROP FUNCTION IF EXISTS private.normalize_legacy_push_token_write();

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_atomic(
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  title text,
  body text,
  data jsonb,
  category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 200);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  RETURN QUERY
  WITH pending AS MATERIALIZED (
    SELECT queued.id, queued.member_id, queued.event_type, queued.data, queued.category,
      queued.available_at, queued.created_at, member.user_id, league.deleted_at
    FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id=queued.member_id
    JOIN public.leagues league ON league.id=member.league_id
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.available_at<=now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at<=now()-make_interval(secs=>v_lease_seconds))
    ORDER BY queued.available_at,queued.created_at,queued.id
    LIMIT CASE WHEN v_limit=0 THEN 0 ELSE GREATEST(v_limit,100) END
    FOR UPDATE OF queued SKIP LOCKED
  ), lineup_contexts AS MATERIALIZED (
    SELECT DISTINCT pending.data->>'leagueId' AS league_key,pending.data->>'memberId' AS member_key
    FROM pending WHERE pending.event_type IN ('lineup_inactive','lineup_empty')
      AND coalesce(pg_input_is_valid(pending.data->>'leagueId','uuid'),false)
      AND coalesce(pg_input_is_valid(pending.data->>'memberId','uuid'),false)
  ), lineup_current AS MATERIALIZED (
    SELECT context.league_key,context.member_key,candidate.event_type,candidate.league_id,
      candidate.member_id,candidate.game_date,candidate.player_id
    FROM lineup_contexts context CROSS JOIN LATERAL private.notif_lineup_candidates_scoped(
      clock_timestamp(),context.league_key::uuid,context.member_key::uuid) candidate
  ), stale AS MATERIALIZED (
    SELECT pending.*, CASE WHEN pending.deleted_at IS NOT NULL THEN 'league_deleted'
      WHEN pending.event_type IN ('lineup_inactive','lineup_empty') THEN
        CASE WHEN NOT EXISTS(SELECT 1 FROM lineup_current candidate
          WHERE candidate.league_key=pending.data->>'leagueId' AND candidate.member_key=pending.data->>'memberId'
            AND candidate.event_type=pending.event_type AND candidate.league_id::text=pending.data->>'leagueId'
            AND candidate.member_id::text=pending.data->>'memberId' AND candidate.game_date::text=pending.data->>'gameDate'
            AND (pending.event_type='lineup_empty' OR candidate.player_id::text=pending.data->>'playerId')) THEN 'stale' END
      WHEN private.notif_is_stale(pending.event_type,pending.data) THEN 'stale' END AS reason
    FROM pending
  ), deferred AS MATERIALIZED (
    SELECT stale.*, CASE WHEN stale.reason IS NULL THEN private.notif_draft_deferred_until(stale.event_type,stale.data) END AS resume_at
    FROM stale
  ), classified AS MATERIALIZED (
    SELECT deferred.*, CASE WHEN deferred.reason IS NOT NULL THEN deferred.reason
      WHEN deferred.resume_at IS NULL AND NOT private.notif_preference_enabled(deferred.user_id,deferred.event_type,deferred.category)
        THEN 'preferences_disabled' END AS suppression
    FROM deferred
  ), delivery AS MATERIALIZED (
    SELECT classified.id FROM classified WHERE classified.suppression IS NULL AND classified.resume_at IS NULL
    ORDER BY classified.available_at,classified.created_at,classified.id LIMIT v_limit
  ), changed AS (
    UPDATE public.notification_outbox queued SET
      suppressed_at=CASE WHEN classified.suppression IS NOT NULL THEN clock_timestamp() ELSE queued.suppressed_at END,
      suppression_reason=COALESCE(classified.suppression,queued.suppression_reason),
      available_at=CASE WHEN classified.resume_at IS NOT NULL AND classified.suppression IS NULL
        THEN LEAST(classified.resume_at,clock_timestamp()+interval '1 minute') ELSE queued.available_at END,
      claimed_at=CASE WHEN delivery.id IS NOT NULL THEN clock_timestamp() ELSE NULL END,
      claim_token=CASE WHEN delivery.id IS NOT NULL THEN gen_random_uuid() ELSE NULL END
    FROM classified LEFT JOIN delivery ON delivery.id=classified.id
    WHERE queued.id=classified.id AND (classified.suppression IS NOT NULL OR classified.resume_at IS NOT NULL OR delivery.id IS NOT NULL)
    RETURNING queued.*
  )
  SELECT changed.id,changed.claim_token,changed.member_id,changed.title,changed.body,
    changed.data||jsonb_build_object('notificationEvent',changed.event_type,'outboxId',changed.id),changed.category
  FROM changed JOIN delivery ON delivery.id=changed.id
  ORDER BY changed.available_at,changed.created_at,changed.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET delivered_at = now(),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET attempt_count = attempt_count + 1,
         available_at = now() + make_interval(
           secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)
         ),
         dead_lettered_at = CASE WHEN attempt_count + 1 >= 12 THEN now() ELSE NULL END,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Unknown notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dead_letter_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET dead_lettered_at = now(),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Permanent notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_process_trades(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= p_now
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= p_now
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.available_at <= p_now
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= p_now - interval '60 seconds')
  ) THEN
    PERFORM private.work_enqueue('process-trades',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

UPDATE public.notification_outbox
   SET claimed_at = NULL, claim_token = NULL, available_at = now()
 WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND expo_ticket_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.record_notification_outbox_ticket_atomic(uuid, uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.claim_notification_receipts_atomic(integer, integer);
DROP FUNCTION IF EXISTS public.defer_notification_receipt_state_atomic(uuid, uuid, text, integer, boolean);
DROP FUNCTION IF EXISTS public.register_push_token_atomic(uuid, text, text);
DROP FUNCTION IF EXISTS public.revoke_push_token_atomic(text, text);
DROP FUNCTION IF EXISTS public.clear_push_token_for_user_atomic(uuid, text);

DROP INDEX IF EXISTS public.notification_outbox_receipt_queue;
DROP INDEX IF EXISTS public.notification_outbox_expo_ticket_unique;
DROP INDEX IF EXISTS public.profiles_push_token_lookup;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_push_token_revocation_pair,
  DROP CONSTRAINT IF EXISTS profiles_push_token_revocation_hash_format;

ALTER TABLE public.profiles
  DROP COLUMN push_token,
  DROP COLUMN push_token_revocation_hash;

ALTER TABLE public.notification_outbox
  DROP COLUMN expo_ticket_id,
  DROP COLUMN push_token,
  DROP COLUMN ticketed_at,
  DROP COLUMN receipt_attempt_count;
```

## Weekly add week for every instant

`20261214011900_total_add_week.sql` replaces `private.current_add_week(uuid, uuid)` with `private.current_add_week(uuid, uuid, timestamptz DEFAULT now())`; every two-argument caller keeps working.
Days inside a scheduled week keep that week's number and reset.
Every other day falls in a bucket of at most 7 days that starts after the previous scheduled week, or the prior season's last week, or on Monday when neither exists, and ends early when the next scheduled week starts.
A league with no schedule and no earlier season now resets every Monday instead of never, and the days before week 1 no longer count toward week 1.
Counts already stored for unscheduled days move to new keys once, so those members get a fresh limit at deploy.
Run `npm run test:db:add-week-property`, `npm run test:db:weekly-add-limit`, and `npm run test:db:limits-all-star-week` on a private stack.
