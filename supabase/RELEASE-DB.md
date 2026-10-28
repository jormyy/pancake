# Release 2.6 database contract

## Release order for this release

Apply the database changes, deploy Edge functions, then merge the frontend.
The integration base is `origin/main` at `78c01b8c`, the release 2.5 source.
The supplied production head is `20261123000100`, with 621 migrations.
This integration makes no production request.
The release planner must verify the applied prefix during an authorized rollout.

Release 2.6 adds four migrations and reaches 625 migrations through `20261124000400`.
The incoming migration timestamps have zero collisions.
Keep all four versions unchanged and apply them in this order.

| Migration | Change |
| --- | --- |
| `20261124000100_trade_value_fetch_retries.sql` | Releases failed daily claims and queues bounded value-fetch retries. |
| `20261124000200_trade_estimate_reanalysis.sql` | Adds versioned trade re-analysis and preserves original quotes in history. |
| `20261124000300_trade_estimate_pick_inputs.sql` | Shares pick inputs and bounds replacement-player reads. |
| `20261124000400_pick_predictions_and_ranking_cleanup.sql` | Stores pick predictions, chains daily refreshes, and removes ranking work. |

Deploy all five changed Edge functions after the database upgrade.
This list uses the release runner import graph against `origin/main` at `78c01b8c`.
It includes callers of changed shared files.
`_shared` is not a deployable function.

| Edge function | Change |
| --- | --- |
| `api` | Uses imported trade scoring, refreshes pick predictions, and runs versioned trade re-analysis. |
| `dispatcher` | Closes vacuum connections after failures and uses a real-time deadline. |
| `refresh-views` | Uses the changed shared dynasty engine. |
| `sync-rankings` | Returns HTTP 410 and performs no fetch or write. |
| `sync-trade-values` | Bounds source attempts, releases failed claims, and schedules retries. |

Use this rollout order:

1. Record compatible frontend and Edge rollback artifacts and verify the applied database prefix.
2. Pause scheduled work through `public.set_worker_paused(true, reason)` and let running work settle.
3. Apply every pending migration through `20261124000400` in version order.
4. Check migration fingerprints, function sources, catalog grants, and database types.
5. Deploy all five Edge functions and check their internal authorization.
6. Import the recorded value fixture and verify publication, pick refresh, and trade re-analysis on a private stack.
7. Merge and deploy the frontend after the database and Edge checks pass.
8. Resume scheduled work and inspect the first daily chain and retry outcomes.

The daily scheduler queues `sync-trade-values` after 07:15 America/New_York.
Quarter-hour checks preserve catch-up and one work key per Eastern day.
League-local midnight waiver work stays in the same scheduler.
The database permits one successful live value publication per Eastern day.
A failed fetch releases its claim and preserves the last complete snapshot.
An abandoned claim expires after three minutes.

Each source attempt has a 75-second body-inclusive timeout, with at most two attempts.
A 110-second source deadline bounds both attempts and their one-second pause.
Database work, cleanup, and invocation checks retain the controlled 135-second total budget.
The service-only retry RPC is `public.fail_trade_value_sync(uuid, integer, date, boolean)`.
Its arguments are request ID, retry number, Eastern retry date, and the schedule flag.
Failure queues the next retry for 30 minutes later, up to retry 4.
Duplicate callbacks cannot enqueue extra work.
The original fetch error stays on the failed work item and sync record.

Successful publication queues `pick-predictions` with the source hash.
The worker calls the internal `api/trades/pick-values-work` route.
It stores closed-form tier odds and values for each league's picks.
`complete_pick_prediction_refresh` rejects stale hashes and incomplete league refreshes.
Completion queues trade re-analysis with history version `onenumber-trade-v1-picks-v1`.
Already converted trades remain unchanged on replay.
Original quotes and earlier history remain available.

Migration `20261124000400` removes pending `sync-rankings` work and its work kind.
It drops `private.enqueue_rankings(timestamptz)` and its hourly scheduler call.
The retired weekly gate formerly runs Monday after 07:00 Eastern, with later-week catch-up.
No separate ranking cron remains to unschedule.
The legacy ranking write RPC returns a retirement result without changing stored values.
Keep the HTTP 410 endpoint through the rollback window.

Private verification uses project `pt4bafabler26` and ports `586xx`.
The upgrade starts at all 621 supplied-head migrations and applies the four-file suffix.
A fresh 625-migration rebuild produces the same four generated artifacts.
The fixed audit anchor stays at 329 migrations through `20261005000003`.
The approved range contains 296 migrations.
The recorded security baseline stays at 564 migrations through `20261029000800`.
Its candidate suffix contains 61 migrations; the verified live prefix determines the actual pending suffix.
[Migration history](../docs/production-migration-history.md#release-26-candidate) records the range.
[Integration evidence](../docs/release-2.6-integration.md) records checks, limits, and every changed file.
[Trade values](../docs/trade-values.md) defines scoring, predictions, matching, and retries.

Keep RPC compatibility, realtime publications, receipts, roster history, and saved trade quotes through rollout.
If a phase fails, stop promotion and restore compatible frontend and Edge artifacts.
Pause scheduled work before recovering an incompatible worker pairing.
Preserve additive data and versioned history.
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

This section contains deferred cleanup, not release 2.6 migration steps.
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

The checked-in attestations cover all 625 migrations through `20261124000400`.
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

## Release 2.6 post-database checks

Run the four release 2.6 migrations in version order after every earlier pending migration.
Check the upgraded database with both current and rollback consumers before frontend promotion.
Run the focused recipes in [verification](../docs/verification.md), then the full release checks.
Keep local fixture evidence separate from rollout evidence.
This integration does not authorize a hosted release.
