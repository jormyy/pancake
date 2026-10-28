# Release 2.5 database contract

## Release order for this release

Database, then Edge, then merge the frontend.
The integration base is `origin/main` at `d267428f`, the release 2.4 source.
The last supplied operator report says: Production currently stops at migration `20261113000200`.
That report belongs to the prior release review; it does not establish the current deployed head.
This integration makes no production request.
The release planner must verify the applied prefix during an authorized rollout.

Release 2.5 adds 13 migrations to the 608-migration integration base.
Apply every pending migration in version order through `20261123000100`, for 621 migrations.
The complete incoming branch histories have zero timestamp collisions.
Their timestamps remain unchanged.
The final migration reconciles function replacements across the merged branches.
Do not omit it when deploying the earlier feature migrations.

| Migration | Change |
| --- | --- |
| `20261117000100_player_link_identity_index.sql` | Indexes player links for identity resolution. |
| `20261117000200_stat_player_resolution.sql` | Resolves stat identities without locking player rows. |
| `20261118000100_public_cli.sql` | Adds share tokens, public reads, limits, and audit retention. |
| `20261118000200_public_matchup_state.sql` | Preserves void flags and multiweek matchup ranges in public reads. |
| `20261118000300_public_stats_seasons.sql` | Reads player statistics from seasons before league creation. |
| `20261120000100_onenumber_trade_values.sql` | Adds value storage, review matching, publication, and daily work. |
| `20261120000200_trade_value_readers.sql` | Supplies stored values to player profiles and trade details. |
| `20261120000300_trade_value_cache_refresh.sql` | Refreshes league readers after value publication or review. |
| `20261121000001_league_midnight_waivers.sql` | Processes scheduled claims at each league midnight. |
| `20261121000004_reschedule_waivers_timezone.sql` | Moves pending claims and drop holds when league time changes. |
| `20261121000005_league_local_view_day.sql` | Uses the league date in shared screen context. |
| `20261122000100_player_views.sql` | Splits player sections and improves dynasty sorting. |
| `20261123000100_release25_player_values_and_schedule.sql` | Preserves league-midnight waivers, daily values, and both profile formats. |

Deploy all 10 changed Edge functions after the database upgrade and before the frontend merge:

- `api`
- `backfill`
- `live-poll`
- `process-waivers`
- `refresh-views`
- `season-boundary`
- `sync-players`
- `sync-scores`
- `sync-stats`
- `sync-trade-values`

This list comes from the release runner import graph against `origin/main` at `d267428f`.
It includes callers of changed shared files, even when their handler file stays unchanged.
`_shared` is not a deployable function.
`sync-trade-values` is new; the other nine functions already exist.
No other Edge function changes against this base.

Use this rollout order:

1. Record compatible frontend and Edge rollback artifacts and the verified database prefix.
2. Pause scheduled work with `private.worker_controls` before applying the pending migration suffix.
3. Apply every pending migration through `20261123000100` in the order above.
4. Verify migration fingerprints, function sources, catalog grants, and database types.
5. Deploy all 10 Edge functions and check internal authorization and public share-token reads.
6. Merge and deploy the frontend, then install or publish the CLI package.
7. Check league-local dates, midnight claims, compact player sections, and stored values.
8. Resume scheduled work after those checks pass.

The new worker runs as `sync-trade-values` at 07:15 America/New_York.
The work dispatcher checks the daily gate each quarter hour and catches up after that time.
The same scheduler retains midnight waiver payloads for each league timezone.
One live value-fetch attempt is allowed per Eastern calendar day.
A failed source attempt preserves the last complete published snapshot.
Recorded JSON and CSV imports use the same validation and atomic publication rules.
The worker uses the existing internal token and work-lease checks.
It is not a public read route.
[Trade values](../docs/trade-values.md) defines scaling, review matching, pick tiers, and import behavior.

The `api` function adds `GET /public/v1/<resource>` before member authentication.
The ten resources are `league`, `standings`, `rosters`, `matchups`, `scores`, `schedule`, `transactions`, `draft-results`, `player-stats`, and `projections`.
Every public resource requires a league share token in the Bearer header.
Commissioners manage tokens through `public_share_token`; public reads cannot manage tokens or write league data.
The API enforces read limits, field allowlists, conditional responses, rotation, and revocation.
A share token does not grant direct database access.
[Public CLI](../docs/public-cli.md) defines schemas, filters, errors, and installation.
The `api` function also adds the authenticated game-times view used by matchup rows.

Home, Roster, and shared screen context use league-local dates.
Waivers use league-local midnight and elapsed 48-hour drop holds.
NBA game dates, score rules, and weekly add boundaries retain their Eastern calendar rules.
Player profiles load overview, games, news, and history separately.
Both the compact overview and legacy profile include stored trade values.
The final integration migration preserves all these behaviors on fresh and upgraded databases.

Private verification uses project `pt4bafabler25` and ports `582xx`.
Cron launch stays disabled throughout migration and fixture checks.
The incremental upgrade and fresh installation produce identical files for both attestations, the function catalog, and database types.
The fixed audit anchor remains 329 migrations through `20261005000003`.
The approved range now has 292 migrations.
The recorded release 1 security baseline remains 564 migrations through `20261029000800`.
Its candidate suffix has 57 migrations; the planner chooses the actual pending suffix from verified history.
[Migration history](../docs/production-migration-history.md#release-25-candidate) records the release range.
[Integration evidence](../docs/release-2.5-integration.md) records executed checks and every changed file.

Keep deployed RPC signatures, realtime publications, receipts, roster history, and saved trade quotes through rollout.
If a phase fails, stop promotion and restore compatible frontend and Edge artifacts.
Keep the additive database and the new worker while queued work can require it.
Pause scheduled work before recovering an incompatible worker pairing.
Repair database behavior with a reviewed forward migration.

## Historical rollout reference

Release 1 includes the final-stat recheck and revision-fence migrations.
Those changes remain in the schema.
Their former `daily-stat-corrections` cron is removed by the work queue migration.
Current corrections run as queued work through `dispatch_work`.
Use the operator pause below for an incident.
Do not unschedule a retired per-job cron.

## Rule references

[Roster lifecycle](../docs/roster-lifecycle.md) defines claims, taxi eligibility, reservations, trade plans, and season transitions.
[Trade estimates](../docs/trade-estimates.md) defines frozen quotes and separate historical revaluation.
[Matchup forecasts](../docs/matchup-forecasts.md) defines inputs, stale results, publication, and concurrency.
[Source monitoring](../docs/source-monitoring.md) defines providers, projection windows, corrections, and retention.
[Verification](../docs/verification.md) lists current recipes and release prerequisites.

## Next release

This section contains deferred cleanup, not release 2.5 migration steps.
The SQL below is not installed by this release.

Drop `leagues.taxi_rule` after the deployed client and its rollback retire.
Every league now uses NBA rookies or fewer than 65 career regular-season games.

The current client accepts `player_stats` and scoped activity changes.
Retain compatibility topics until older clients and their rollback artifacts retire.
Drop `standings.waiver_priority` after old Edge writers and their rollback window retire.
Live waiver order already uses `waiver_priorities`.


Keep `weekly_lineups`, `waiver_claims`, and `waiver_wire_log` in `supabase_realtime` through this release.
The deployed Roster screen and its rollback still subscribe to these tables.
Remove them only after the new client ships and its rollback window closes.

```sql
ALTER PUBLICATION supabase_realtime DROP TABLE
  public.weekly_lineups, public.waiver_claims, public.waiver_wire_log;
ALTER TABLE public.weekly_lineups REPLICA IDENTITY DEFAULT;
ALTER TABLE public.waiver_claims REPLICA IDENTITY DEFAULT;
ALTER TABLE public.waiver_wire_log REPLICA IDENTITY DEFAULT;
```

The checked-in attestations cover all 621 migrations through `20261123000100`.
Recheck their source fingerprints before deployment.
The published attestations retain the recorded release 1 baseline.

Keep the Expo objects while the deployed Edge release or its rollback can use them.
The client cannot update `profiles.push_token`; the service role keeps access.
The database phase also keeps receipt tickets and their current leases.

First ship an Edge release that removes Expo delivery, receipt polling, and legacy storage access.
Settle pending tickets and close its rollback window.
Then assign a new migration version after the repository head for the SQL below.
This SQL stays outside `supabase/migrations` until that release.
It requeues pending tickets, replaces the queue routines, and then removes the legacy objects.
Remove their canonical sources and catalog entries, then regenerate types for that release.

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
  ), stale AS MATERIALIZED (
    SELECT pending.*, CASE WHEN pending.deleted_at IS NOT NULL THEN 'league_deleted'
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

## Worker incident controls

Cron calls `public.dispatch_work()` directly.
Replacing the Edge `dispatcher` does not pause the SQL scheduler or other workers.
Pause new scheduled work with the operator RPC:

```sql
SELECT public.set_worker_paused(true, 'Investigating database load');
```

Inspect the saved control and queue before resuming:

```sql
SELECT * FROM private.worker_controls;
SELECT * FROM public.work_dashboard();
SELECT * FROM public.retention_dashboard();
```

Confirm that existing workers finish or lose their leases.
Check failed work and invocation outcomes before retrying.
Retain dead items for diagnosis.
Do not delete queue rows to hide a failure.
Resume only after the cause is understood and the relevant local checks pass:

```sql
SELECT public.set_worker_paused(false, 'Database checks pass');
SELECT * FROM public.work_dashboard();
```

Confirm that due work starts and failure counts stop growing.

Only the service role and database owner can call this RPC.
The flag lives in the singleton `private.worker_controls` row.
The scheduler checks it before enqueueing or claiming work.
The flag does not cancel a statement already running.
Service-role requests have a three-second statement budget and a 250ms lock budget.
The cron command sets a five-second outer statement budget before calling the dispatcher.
A timeout set inside an already running SQL function does not replace that outer budget.
Retention statements delete at most 5,000 rows and skip locked candidates.
Each retention pass stops starting new helpers after two seconds.
The queue admits at most eight active workers.
Screen refresh claims one season and at most 20 trade valuations per run.
Incomplete valuation sets keep the season dirty for continuation.

Apply `20261114000100_bounded_worker_database_work.sql`, then `20261114000200_worker_pause_control.sql`.
Deploy `refresh-views` after these migrations.

## Dispatcher transaction budget

Apply `20261114000300_bounded_dispatch_transactions.sql` after the worker safeguards.
This change needs no Edge deployment.
Each dispatch claims one item at a time, with at most eight claims.
It starts no new item after two seconds.
The existing cron command keeps its five-second statement limit and 250 ms lock limit.
Unclaimed items remain pending; no lease starts before an item can run.
A blocked item records its error before the transaction commits.
The dispatcher advisory lock skips overlapping runs.
Run `npm run test:db:dispatcher-contention` on an idle private stack.
The recipe holds worker rows and the HTTP queue while it checks bounded dispatch and overlap.
A queued HTTP backlog alone does not prove insertion contention.
Startup timeouts occur before SQL execution; retain full error context when investigating a failed statement.

Duplicate active work returns before insertion, using the existing active-work index.
This avoids waiting on an unrelated lease update during a uniqueness check.
The unique index still rejects concurrent duplicate inserts.

Apply `20261114000400_player_birthdate_simulated_clock.sql` after the dispatcher transaction repair.
The birthdate constraint uses `private.valid_player_birthdate(date)` with `now()::date`.
This keeps both date bounds and lets the replay install its supported transaction clock.
No Edge deployment is required.

## Release 2.5 post-database checks

Run the release 2.5 migration table in version order after every earlier pending migration.
Check the upgraded database with both current and rollback consumers before frontend promotion.
Run the focused recipes in [verification](../docs/verification.md), then the full release checks.
Keep local fixture evidence separate from rollout evidence.
This integration does not authorize a hosted release.
