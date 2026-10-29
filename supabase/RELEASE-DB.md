# Release 2.7.1 database contract

## Release order for this release

The supplied production head is `20261209000500`, with 675 migrations.
Apply the four migrations in [Release 2.7.1](#release-271) order through `20261210000300`.
Apply the database changes, deploy the six listed Edge functions, then release the frontend.
This integration makes no production request.

## Release 2.6 historical contract

Apply the database changes, deploy Edge functions, then merge the frontend.
The integration base is `origin/main` at `78c01b8c`, the release 2.5 source.
Production currently stops at migration `20261123000100` for the recorded release 2.6 baseline, with 621 migrations.
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

This section contains deferred cleanup, outside the release 2.7 migration steps.
The SQL below is not installed by this release.

Drop `leagues.taxi_rule` after the deployed client and its rollback retire.
Every league now uses NBA rookies or fewer than 65 career regular-season games.

The current client accepts `player_stats` and scoped activity changes.
Retain compatibility topics until older clients and their rollback artifacts retire.
Drop `standings.waiver_priority` after old Edge writers and their rollback window retire.
Live waiver order already uses `waiver_priorities`.


Release 2.7 publishes exactly the tables watched by the current client.
Keep the app-wide hint stream and screen subscriptions through rollback.

The checked-in attestations cover all 675 migrations through `20261209000500`.
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

## Release 2.6.2 live scoring lock fix

Apply migration `20261128000100_live_poll_injury_contention.sql` after `20261124000400`.
It replaces `private.recount_changed_player_careers` so the career trigger locks a player row only when the appearance count changes.
Deploy every Edge function; `_shared/databaseRetry.ts`, `live-poll`, `sync-player-injuries` and `sync-players` changed.
The injury worker now commits one short transaction per player batch, and the live scoring loop retries a lock timeout per tick.
Evidence and the blocking statement pair are in [docs/live-scoring-lock-contention.md](../docs/live-scoring-lock-contention.md).
Rollback: redeploy the release 2.6.1 Edge functions; the migration is safe to keep.

## Release 2.6.3

The integration starts at `045f2d09`, the release 2.6.2 source.
The supplied production head is `20261128000100`, with 626 migrations.
The two migrations reach `20261130000100`, with 628 migrations.

| Order | Migration | Change |
| --- | --- | --- |
| 1 | `20261129000100_restore_hashtag_rankings.sql` | Restores Hashtag readers, ranking writes, and hourly work. Preserves OneNumberHoops trade inputs. |
| 2 | `20261130000100_player_page_speed.sql` | Keeps Hashtag sources and computes league fantasy averages once per dynasty read. |

Hashtag supplies five-year points, three-year points, dynasty ranks, and rookie ranks.
Future picks use the original release 2.4 curve.
OneNumberHoops supplies trade calculations, estimates, pick predictions, and re-analysis.
Its stored player values and pick bands stay intact.
The [reader map](../docs/dynasty-rankings-restoration.md) records each source.
The dynasty reader keeps its arguments, columns, grants, and snapshot values.

Only one Edge function changes against `origin/main` at `045f2d09`.

| Edge function | Required deployment |
| --- | --- |
| `sync-rankings` | Deploy the restored worker, parser, matching, forms, and view selection. It replaces the retired HTTP 410 handler. |

Use this rollout order:

1. Record rollback artifacts and verify the applied database prefix.
2. Pause scheduled work with `public.set_worker_paused(true, reason)` and let running work settle.
3. Apply both migrations in the listed order after every earlier pending migration.
4. Check migration fingerprints, function sources, catalog grants, and database types.
5. Deploy `sync-rankings` and verify its internal authorization.
6. Check all three Hashtag views and preserved trade values on a private stack.
7. Deploy the frontend after database and Edge checks pass.
8. Resume scheduled work and inspect the first ranking refresh.

The hourly scheduler retains weekly success keys and Monday's 07:00 Eastern gate.
The worker writes three-year, rookie, then five-year rows.
Daily trade work and league-local midnight waiver work stay scheduled.

Rollback: pause scheduled work and restore the previous frontend.
Keep both migrations and the restored `sync-rankings` worker.
Trade input signatures and stored OneNumberHoops rows remain compatible.
Keep work paused if worker compatibility is uncertain.
Use a reviewed forward migration for a database repair.
Resume work after the relevant private checks pass.

[Migration history](../docs/production-migration-history.md#release-263-candidate) records the combined range.
[Integration evidence](../docs/release-2.6.3-integration.md) records checks and every changed file.

## Release 2.7

The source baseline is `origin/main` at `acafdf80`, release 2.6.4.
The supplied database head is `20261130000100`, with 628 migrations.
The ordered pending set adds 47 migrations and reaches 675 through `20261209000500`.
Twenty-eight pending versions precede the supplied head. Include all missing versions in numeric order.
All versions are distinct. No migration is renumbered.

| Order | Migration | Change |
| --- | --- | --- |
| 1 | `20261119000100_skip_unchanged_lineup_slots.sql` | Skip unchanged lineup slots. |
| 2 | `20261119000200_churn_table_storage_policy.sql` | Churn table storage policy. |
| 3 | `20261119000300_player_identity_lookup.sql` | Player identity lookup. |
| 4 | `20261119000400_reviewed_player_provider_links.sql` | Reviewed player provider links. |
| 5 | `20261119000500_reconcile_missing_final_stats.sql` | Reconcile missing final stats. |
| 6 | `20261119000600_provider_write_gate.sql` | Provider write gate. |
| 7 | `20261119000700_terminal_work_retention.sql` | Terminal work retention. |
| 8 | `20261119000800_application_session_limits.sql` | Application session limits. |
| 9 | `20261119000900_schedule_write_gate.sql` | Schedule write gate. |
| 10 | `20261119001000_append_event_time_index.sql` | Append event time index. |
| 11 | `20261119001100_preserve_lock_free_stat_resolution.sql` | Preserve lock free stat resolution. |
| 12 | `20261119001200_preserve_incomplete_season_calendar.sql` | Preserve incomplete season calendar. |
| 13 | `20261119001300_partition_beacons_and_receipts.sql` | Partition beacons and receipts. |
| 14 | `20261119001400_scope_notification_lineup_checks.sql` | Scope notification lineup checks. |
| 15 | `20261119001500_partition_events_and_invocations.sql` | Partitions events and invocations. Preserves column grants, policies, and version triggers. |
| 16 | `20261119001600_complete_public_read_retention.sql` | Complete public read retention. |
| 17 | `20261119001700_refresh_trade_value_statistics.sql` | Refresh trade value statistics. |
| 18 | `20261125000100_partition_player_game_stats.sql` | Partition player game stats. |
| 19 | `20261125000200_partition_notification_outbox.sql` | Partition notification outbox. |
| 20 | `20261125000300_restore_missing_final_stats_schedule.sql` | Restore missing final stats schedule. |
| 21 | `20261125000400_restore_native_outbox_uniqueness.sql` | Restore native outbox uniqueness. |
| 22 | `20261125000500_preserve_reconciliation_after_rankings_retirement.sql` | Preserve reconciliation after rankings retirement. |
| 23 | `20261125000600_batch_lineup_notification_claims.sql` | Batch lineup notification claims. |
| 24 | `20261125000700_skip_unchanged_forecast_queue_writes.sql` | Skip unchanged forecast queue writes. |
| 25 | `20261125000800_remove_roster_member_prefix_index.sql` | Remove roster member prefix index. |
| 26 | `20261125000900_index_pending_edge_invocations.sql` | Index pending edge invocations. |
| 27 | `20261126000100_corroborate_null_team_player_identities.sql` | Repairs nine player identities from matching source evidence. |
| 28 | `20261127000100_database_probe_repairs.sql` | Versions league events and moves public-read retention into dispatcher work. |
| 29 | `20261201000100_daily_screen_statistics.sql` | Daily screen statistics. |
| 30 | `20261201000200_preserve_reconciliation_with_hashtag_rankings.sql` | Keeps missing-stat repair and updates existing guarded minute jobs. |
| 31 | `20261201000300_reuse_current_forecast_projection_inputs.sql` | Reuse current forecast projection inputs. |
| 32 | `20261201000400_index_recent_score_dispatches.sql` | Index recent score dispatches. |
| 33 | `20261201000500_share_player_average_refresh_source.sql` | Share player average refresh source. |
| 34 | `20261201000600_bound_hint_drain.sql` | Applies the guarded five-second hint drain through cron.alter_job. |
| 35 | `20261201000800_defer_contended_balance_publications.sql` | Defer contended balance publications. |
| 36 | `20261201000900_draft_only_realtime.sql` | Publishes the exact union of current client subscriptions. |
| 37 | `20261201001000_cap_worker_dispatch.sql` | Cap worker dispatch. |
| 38 | `20261201001100_player_game_keyset.sql` | Player game keyset. |
| 39 | `20261201001200_guard_minute_workers.sql` | Keeps both minute workers bounded and prevents overlapping runs. |
| 40 | `20261201001300_separate_forecast_publication.sql` | Separate forecast publication. |
| 41 | `20261201001400_gate_idle_screen_refresh.sql` | Gate idle screen refresh. |
| 42 | `20261202000100_authorize_trade_receipt_replays.sql` | Requires current membership and request ownership before trade receipt replay. |
| 43 | `20261204000100_trade_structured_legality.sql` | Adds structured legality, incoming destinations, and atomic saved roster moves. |
| 44 | `20261205000100_pending_asset_locks.sql` | Locks pending assets and preserves transaction-bound executor proof. |
| 45 | `20261206000100_trade_pick_labels.sql` | Adds pick ownership to activity readers and shared pick labels. |
| 46 | `20261207000100_release27_dispatcher_convergence.sql` | Combines scheduler work and handles trade capacity conflicts during waiver processing. |
| 47 | `20261209000500_matchup_forecast_season_fallback.sql` | Adds current-season averages to both forecast context readers. |

`public.dispatch_work` owns public-read retention and its bounded hourly prune.
Catch-up starts after minute 17. The separate `public-read-retention` cron job is unscheduled.
The scheduler keeps Hashtag rankings, missing-final-stat repair, and daily table analysis.
The dispatcher claims at most four workers and stops after its transaction budget.
Realtime retains all 16 tables watched by the current client.
Version polling complements those subscriptions.
The hint drain and cron-history cleanup retain their maintenance jobs.

Migrations `20261201000200`, `20261201000600`, and `20261201001200` use `cron.alter_job` on existing job IDs.
They accept the supplied live minute schedules and advisory-lock commands.
The final commands retain five-second statement limits, 250-millisecond lock limits, and session overlap guards.
Repeated application preserves job IDs, counts, schedules, and commands.

Ordinary roster writes enforce pending asset locks.
Saved trade moves require the executor context, private transaction proof, and an exact saved destination.
Waiver workers handle the HTTP-compatible trade capacity conflict code as a failed roster claim.
All three former bug recipes require fixed behavior. `tests/db/known-bugs.json` is empty.

### Realtime publication

The static subscription check follows direct calls, imported watch helpers, aliases, maps, and dynamic imports.
It compares that union with the final publication across ordered migrations.
It rejects both missing subscriptions and unwatched published tables.
Unresolved watch expressions or later publication changes fail the check.

| Table | Active client reader |
| --- | --- |
| `draft_budgets` | Auction draft subscription. |
| `draft_picks` | Trade screen watch helper. |
| `drafts` | Auction and rookie draft subscriptions. |
| `league_change_hints` | App-wide league change stream. |
| `league_members` | League list and player support. |
| `leagues` | League list. |
| `matchup_forecasts` | Matchup forecast hook. |
| `nominations` | Auction draft subscription. |
| `roster_players` | Player support. |
| `snake_draft_picks` | Rookie draft subscription. |
| `trade_block_items` | Trade screen watch helper. |
| `trade_items` | Trade screen watch helper. |
| `trade_participants` | Trade screen watch helper. |
| `trade_vetos` | Trade screen watch helper. |
| `trades` | Trade screen watch helper. |
| `waiver_claims` | Member claims stream. |

The migration removes six unwatched tables from the supplied 22-table publication.
They are `draft_room_members`, `matchups`, `roster_transactions`, `waiver_priorities`, `waiver_wire_log`, and `weekly_lineups`.
No active client subscribes to `draft_room_members`.
The unused `leagueScreenWatches` factory does not create a subscription.
Its unused history and settings watches do not enter the union.
The migration version and filename stay unchanged. Reset the private stack before regenerating attestations.

### Changed Edge functions

The release runner import graph compares this source with `origin/main` at `acafdf80`.
These seven deployable functions change, including callers of changed shared files.

| Function | Change |
| --- | --- |
| `api` | Adds structured trade legality and saved roster-plan responses. |
| `backfill` | Preserves incomplete schedule calendars through the shared schedule helper. |
| `matchup-forecast` | Uses fresh live projections without frozen values and keeps limited estimates numeric. |
| `process-trades` | Uses scoped notification lineup checks. |
| `refresh-views` | Uses the changed shared schedule helper. |
| `sync-players` | Links player sources using matching identity evidence. |
| `sync-schedule` | Preserves incomplete schedule calendars. |

### Rollout

1. Verify the applied database history and record compatible frontend and Edge rollback artifacts.
2. Pause dispatcher work and let running work settle.
3. Apply all 47 missing migrations in the listed order with older pending versions included.
4. Check migration fingerprints, column grants, function sources, catalog grants, and database types.
5. Confirm public-read retention has no separate cron job. Check both guarded minute worker definitions.
6. Deploy the seven listed Edge functions, then release the frontend.
7. Resume dispatcher work. Check saved trade execution, ordinary asset locks, retention, and daily analysis.

The private rehearsal uses only `pt4bafabler27` and ports `600xx` on the mini.
The catalog, database types, and both attestation files regenerate there.
The forecast worker requires the final migration before deployment.
It keeps frozen values and marks substituted estimates in the frontend.
No production service receives a request during integration.

### Rollback

Restore compatible frontend and Edge artifacts and pause affected work.
Keep the additive schema, partitioned data, native outbox keys, and dispatcher ownership.
Preserve receipts, saved trade plans, identity links, pending locks, and executor proof checks.
Use a reviewed forward migration for database repairs.
Do not restore obsolete cron jobs or remove partitions that contain retained data.

[Integration evidence](../docs/release-2.7-integration.md) records exact checks, limits, and every changed file.

## Release 2.7.1

The source base is release 2.7 at `f1c1f6ec`.
The supplied production head is `20261209000500`, with 675 migrations.
The candidate adds four distinct versions and ends at `20261210000300`, with 679 migrations.
No migration version changes.

| Order | Migration | Change |
| --- | --- | --- |
| 1 | `20261209000600_league_schedule.sql` | Adds the member's season schedule read. |
| 2 | `20261210000100_scheduler_watchdog.sql` | Measures scheduler health and limits work under load. |
| 3 | `20261210000200_certify_inactive_zero_rows.sql` | Removes absent inactive zero rows before final certification and records removed rows. |
| 4 | `20261210000300_isolate_screen_statistics.sql` | Moves statistics into an independent daily job and retires queued analysis work. |

### Changed Edge functions

The release runner's import graph compares this candidate with `origin/main` at `f1c1f6ec`.
Shared file changes affect six deployable functions.

| Function | Change |
| --- | --- |
| `api` | Registers the Schedule view. |
| `backfill` | Includes the corrected shared stat certification. |
| `live-poll` | Ignores absent inactive zero rows during certification. |
| `season-boundary` | Includes the corrected shared stat certification. |
| `sync-scores` | Includes the corrected shared stat certification. |
| `sync-stats` | Ignores absent inactive zero rows during certification. |

### Rollout

1. Verify the applied history matches the supplied production prefix.
2. Save compatible frontend and Edge rollback artifacts.
3. Pause dispatcher work and let active work finish.
4. Apply the four migrations in numeric order.
5. Verify migration fingerprints, function sources, grants, database types, and the realtime publication.
6. Deploy the six listed Edge functions.
7. Release the frontend with Schedule, Daily Total, matchup navigation, and selected-day lineup controls.
8. Resume dispatch and read `public.get_scheduler_health()` with the service role.
9. Check schedule reads, stat certification, scheduler recovery, and the independent statistics job.

The realtime publication remains the same 16-table client watch set.
Schedule uses the existing screen version cache and adds no subscription.
Private rehearsal uses `pt4bafabler271` and ports `612xx` on the mini.
The function catalog, database types, and both attestations regenerate from that private database.

### Watchdog thresholds

Health examines at most 40 recent cron rows within five minutes.
The success ratio uses completed dispatcher runs.
Any cron startup timeout enters `paused`.
Dispatcher success below 50% also enters `paused`.
Success below 80%, average duration above three seconds, or unavailable health enters `shed`.
A restricted state needs ten continuous healthy minutes to recover.
A missing sample, failed check, or check gap above 90 seconds resets recovery.
Manual pause remains separate and stops all dispatch.

In `shed`, only live polling, scoring, stat sync, waivers, trades, and invocation reconciliation can run.
Live polling runs on even minutes; waiver enqueue runs every 15 minutes.
In `paused`, only waivers, trades, and live polling can run, once per five-minute dispatch batch.
Nonessential queued work keeps its due date and attempt count.
The four-worker cap and two-second dispatch budget remain in force.

`public.get_scheduler_health()` reads the last saved measurement without changing state.
Read `level`, manual `paused`, `checked_at`, `healthy_since`, and `last_reduced_dispatch_at` first.
The nested `health` object includes samples, success ratio, durations, startup timeouts, and backend counts.
The nested `hint` contains the latest transition reason and revision.
Alert on stale `checked_at` as well as restricted levels.
The watchdog cannot recover a dispatcher that cron cannot start.
[Scheduler operations](../docs/operations-scheduler.md) explains the allowed work and transition log.

### Statistics job

`screen-statistics` runs at `15 10 * * *` in its own cron connection.
Its command sets a ten-minute statement timeout, a two-second lock timeout, and 16 MB maintenance memory.
It analyzes one named relation per statement and continues after a lock timeout.
The 15 targets retain their existing autovacuum settings.
Partitioned parents still need manual statistics; their ANALYZE also visits child partitions.

The migration retires `analyze-screen-table` and marks outstanding items dead.
Retired kinds cannot enqueue, claim, or execute work.
Retention, partition creation, and trade triggers no longer analyze tables.
Catalog checks reject inline ANALYZE, VACUUM, and REINDEX outside the statistics job.
A slow daily job cannot cancel the dispatcher's separate statement.

[Isolation evidence](../docs/release-2.7.1-statistics-isolation.md) records production-shaped timings and concurrency checks.

### Rollback

Pause dispatch before restoring compatible frontend and Edge artifacts.
Keep the additive schema and stat cleanup audit rows.
Do not restore removed inactive rows blindly; later certified snapshots may supersede them.
Use a reviewed forward migration for database repairs.
If the watchdog requires removal, restore the release 2.7 dispatcher definition through a reviewed forward migration.
Keep manual pause active until health and queue checks pass.
Keep statistics outside dispatch during rollback.
Disable the independent cron job if needed; do not restore the retired inline work kind.
This integration performs no production rollout or rollback.

[Integration evidence](../docs/release-2.7.1-integration.md) records exact checks and every changed file.
