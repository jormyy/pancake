# Release database contract

## Release order for this release

Database, then Edge, then merge the frontend.
Production currently stops at migration `20261029000800`.
Release 1 reaches production on 2026-10-27 from frontend commit `1e62824e43044d30007b9601a8a3993c576b6a7e`.
Apply release 2 through repository head `20261111000100`, for 589 migrations.
Keep published migrations unchanged.

| Migration | Change |
| --- | --- |
| `20261101000100_screen_view_storage.sql` | Adds stored screen results and their refresh queue. |
| `20261101000200_screen_views.sql` | Adds member-scoped screen reads and refresh functions. |
| `20261102000100_league_versions.sql` | Adds league versions and one change event per committed league write. |
| `20261103000100_request_receipts.sql` | Stores request receipts to make write retries safe. |
| `20261103000200_request_receipt_retention.sql` | Expires request receipts during history cleanup. |
| `20261103000300_client_settings_receipts.sql` | Saves client settings through request receipts. |
| `20261104000100_work_queue.sql` | Replaces separate job schedules with a leased work queue and dispatcher. |
| `20261105000100_perf_beacons.sql` | Stores sampled screen timing beacons and private summaries. |
| `20261106000100_team_timeline.sql` | Stores private team timeline events. |
| `20261106000200_timeline_producers.sql` | Records claims, trades, lineups and score events. |
| `20261106000300_timeline_slot_settings.sql` | Records lineup slot setting changes. |
| `20261107000100_lineup_history_locks.sql` | Preserves locked historical lineups. |
| `20261107000101_restore_lineup_history.sql` | Restores retained lineup history. |
| `20261107000102_closed_lineup_slates.sql` | Protects closed lineup dates. |
| `20261107000200_linear_rookie_drafts.sql` | Adds linear rookie draft order. |
| `20261107000201_rookie_mock_order.sql` | Keeps rookie mock draft order consistent. |
| `20261107000300_league_timezone.sql` | Stores league time zones. |
| `20261107000400_player_birthdates.sql` | Adds player birthdates to screen views. |
| `20261107000500_player_injury_details.sql` | Adds player injury details. |
| `20261107000501_player_search_details.sql` | Includes injury details in player search. |
| `20261107000600_activity_player_mentions.sql` | Adds player mentions to league activity. |
| `20261109000100_daily_retention.sql` | Runs daily bounded retention and records cleanup results. |
| `20261109000900_dynamic_provider_policy.sql` | Derives provider history windows from policy and preserves career eligibility. |
| `20261110000100_screen_view_clients.sql` | Adds complete server views for client screens. |
| `20261111000100_screen_publication_versions.sql` | Publishes screen refresh versions. |

Freeze the reviewed source and record the current frontend and Edge artifacts before release.
Refresh migration-range and database security attestations for this exact candidate.
[Migration history](../docs/production-migration-history.md#candidate-migrations) defines the baseline and approval boundaries.

Deploy these changed Edge functions after the database upgrade and before the frontend merge:

- `api`: Screen views, league versions, request receipts, settings writes, and timing beacons.
- `dispatcher`: Leased delayed work and response cleanup.
- `refresh-views`: Stored screen result refreshes.
- `backfill`: Provider history policy and shared worker handling.
- `close-expired-nominations`, `lineup-optimizer`, `live-poll`, `matchup-forecast`, `process-trades`, and `process-waivers`: Shared worker leases and outcomes.
- `season-boundary`, `sync-draft-order`, `sync-player-injuries`, `sync-players`, `sync-projections`, and `sync-rankings`: Shared worker leases and outcomes.
- `sync-schedule`, `sync-scores`, `sync-sleeper-projections`, `sync-stats`, and `verify`: Shared worker leases and outcomes.

Changes to `_shared/serve.ts` and `_shared/syncRuns.ts` affect these bundled handlers.
`_shared` is not a deployable function.
Use the release runner's import graph to confirm the complete changed-function set.
A directory-only diff misses functions that import changed shared code.

Apply each dependency before its consumer:

| Consumer | Required database changes |
| --- | --- |
| Screen routes and `refresh-views` | Screen stores, `view_*` reads, refresh queue, and refresh functions through `20261110000100`, with publication versions from `20261111000100`. |
| Version route and client reconciliation | `league_versions`, `league_changes`, `get_league_version`, and committed-change triggers from `20261102000100`. |
| Retried mutations and settings | Request receipts, guarded write functions, and `save_client_settings_atomic` through `20261103000300`. |
| Worker handlers and event readers | Work items, lease functions, invocation columns, and member-scoped `league_events` from `20261104000100`. |
| Beacon route and client collector | `perf_beacons` and restricted summary functions from `20261105000100`. |
| Retention workers and backfill | Retention rules and provider history policy through `20261109000900`. |

The work queue migration removes these scheduler entry points:

- `invoke_close_expired_nominations_if_due`, `invoke_stats_sync_dispatch_if_due`, `invoke_process_trades_if_due`, and `invoke_live_poll_if_due`.
- `invoke_matchup_forecasts_if_due`, `invoke_lineup_optimizer_if_due`, `invoke_season_boundary_if_due`, and `invoke_pre_tipoff_optimizer_if_due`.
- `invoke_player_injuries_if_due`, `invoke_projection_sync_if_due`, `invoke_edge_function_at_et_time`, and `invoke_dynasty_ranking_views_at_et_time`.
- `private.claim_cron_dispatch`, `private.invoke_claimed_edge_function`, and `cron_dispatch_state`.

Their scheduling duties move to `private.enqueue_*`, `private.work_items`, and `public.dispatch_work`.
The migration replaces the old cron jobs with `work-dispatcher`.
That single cron runs `SELECT public.dispatch_work()` every minute.
Daily retention becomes queued work after 10:00 UTC; it does not add another cron.
Update current test tools to use queue state, leases, and retry deadlines.
Keep historical benchmark fixtures tied to their historical schemas.

Preserve objects used by the deployed frontend, Edge handlers, and rollback artifacts through the database phase:

- Existing RPC names, positional arguments, optional defaults, and return columns.
- `weekly_lineups`, `waiver_claims`, and `waiver_wire_log` realtime publications.
- `leagues.taxi_rule`, `standings.waiver_priority`, and deployed hint topics and resources.
- `profiles.push_token`, `profiles.push_token_revocation_hash`, Expo receipt columns, and receipt RPCs.
- `invoke_edge_function`, invocation start/finish functions, and existing worker payload fields.

The removed scheduler entry points serve old cron jobs; deployed frontend and Edge consumers do not call them.
Unschedule their jobs in the same migration before the new schedule becomes visible.
Check deployed consumers against the upgraded database before promoting Edge or frontend artifacts.

Run lightweight source checks on the Mac:

```sh
npx vitest run tests/release-edge-compatibility.test.ts tests/e2e-release-contracts.test.ts
npm run lint:all
npm run check:edge-shared
npm run check:core-cjs
npm run check:db-function-sources
```

The compatibility check detects missing release steps and changes that break deployed consumers.
Its negative controls remove the release section, production baseline, and newest migration.
The release checks reject incomplete evidence, missing measurements, and unsafe browser fixtures.
Lint and generated-source checks detect code errors and drift between runtime copies.

Run database, Edge, and browser recipes on an isolated mini stack.
Use the [local setup](../docs/verification.md#local-stack) and the stack's own local connection values.
Apply the ordered upgrade from `20261029000800` before exercising both deployed and candidate consumers.

```sh
npm run test:db:continuous-faab
npm run test:db:continuous-faab-schedule
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/inactive-trade-block.sql
npm run test:db:trade-plan-moves-capacity
npm run test:db:trade-plan-concurrency
npm run test:db:trade-waiver-concurrency
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-estimate-snapshots.sql
npm run test:db:trade-historical-revaluation
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/matchup-forecast-cache.sql
node supabase/tests/db/matchup-forecast-concurrency.mjs
npm run test:db:pre-tipoff-live-concurrency
npm run check:database-types
npm run check:db-function-catalog
npm run check:edge-functions
npm run e2e:web-targets
```

Set `PANCAKE_TEST_DB_PORT` to the private stack's database port for the forecast concurrency recipe.
FAAB checks cover ownership, cutoff, priority, balances, retries, and daylight saving boundaries.
Trade checks cover inactive assets, atomic plans, competing reservations, immutable quotes, and historical reads.
Forecast checks cover membership, stale revisions, claims, expiry, retries, and concurrent publication.
The lineup check forces ingestion and optimization to overlap and checks scores and unchanged assignments.
Catalog, type, and Edge checks detect schema or runtime contract drift.
Browser checks exercise supported clients against the seeded release build.
Use the [late-start replay](../docs/season-simulator.md#fresh-replay-launch) for remaining historical windows.
Its acceptance excludes earlier unmeasured windows.
The [release gates](../docs/verification.md#release-gates) define complete artifact and deployment evidence.

After the database upgrade, check the recorded frontend and Edge against that schema.
Deploy Edge and check its callers before merging the frontend.
A merge to main also starts frontend deployment.

If a phase fails, stop promotion and restore the recorded frontend and Edge artifacts.
Keep the migrated database, saved trade quotes, roster history, and corrected statistics.
Scheduled FAAB remains authoritative; old instant-add calls still fail safely.
An older client cannot restore immediate pickups.
If forecast dispatch must stop, pause its work kind through a reviewed forward repair.
Keep the dispatcher running for unrelated work.
Repair forward through a reviewed migration and repeat compatibility checks before resuming.
Do not reverse migrations or rewrite settled ownership and scores to recover an artifact.

## Previous release order

Database, then Edge, then merge the frontend.
The previous release adds `20261028000100_recheck_final_stats.sql`, then `20261028000200_fence_final_stat_revisions.sql`.
It allows overdue final-game checks without another active game.
It queues one seven-day correction window per Eastern date, starting after 06:20.
The fenced worker processes that window one game at a time.
Final snapshots carry publication times so older feeds cannot replace newer verified results.

That rollout deploys `sync-players` for placeholder filtering.
It also deploys `sync-stats`, `sync-scores`, `live-poll`, `backfill`, and `season-boundary` for revision-aware writes.
These functions belong to the previous rollout; the current changed-function list appears above.

`npm run test:db:stats-corrections` checks overdue finals, retry windows, daily idempotence, completed jobs, DST, and client grants.
`npm run test:db:final-stat-revisions` checks revision ordering and atomic score and statistics writes.
If correction dispatch must stop, unschedule `daily-stat-corrections` and retain the schema and corrected data.

## Rule references

[Roster lifecycle](../docs/roster-lifecycle.md) defines claims, taxi eligibility, reservations, trade plans, and season transitions.
[Trade estimates](../docs/trade-estimates.md) defines frozen quotes and separate historical revaluation.
[Matchup forecasts](../docs/matchup-forecasts.md) defines inputs, stale results, publication, and concurrency.
[Source monitoring](../docs/source-monitoring.md) defines providers, projection windows, corrections, and retention.
[Verification](../docs/verification.md) lists current recipes and release prerequisites.

## Next release

Drop `leagues.taxi_rule` after the deployed client and its rollback retire.
Every league now uses NBA rookies or fewer than 65 career regular-season games.

Add the dedicated `player_stats` topic and scoped `activity` inventory resource only after the deployed receiver accepts them.
Keep this release's Players tab subscribed to `score` until that change ships.
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

The merged migration range requires new release attestations before deployment.
The published attestations retain the recorded production baseline.

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
  WITH deleted AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id=queued.member_id
    JOIN public.leagues league ON league.id=member.league_id AND league.deleted_at IS NOT NULL
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL AND queued.suppressed_at IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at<=now()-make_interval(secs=>v_lease_seconds))
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at=clock_timestamp(),suppression_reason='league_deleted',
    claimed_at=NULL,claim_token=NULL FROM deleted WHERE queued.id=deleted.id;
  WITH stale AS (
    SELECT queued.id FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL
      AND queued.available_at <= clock_timestamp()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND private.notif_is_stale(queued.event_type,queued.data)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = clock_timestamp(), suppression_reason = 'stale',
    claimed_at = NULL, claim_token = NULL FROM stale WHERE queued.id = stale.id;
  WITH disabled AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id = queued.member_id
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL
      AND queued.available_at <= now()
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND NOT private.notif_preference_enabled(member.user_id,queued.event_type,queued.category)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = now(), suppression_reason = 'preferences_disabled',
    claimed_at = NULL, claim_token = NULL FROM disabled WHERE queued.id = disabled.id;
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
       AND queued.suppressed_at IS NULL
       AND EXISTS (SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
         WHERE member.id=queued.member_id AND league.deleted_at IS NULL)
       AND NOT private.notif_is_stale(queued.event_type,queued.data)
       AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
       AND private.notif_preference_enabled((SELECT member.user_id FROM public.league_members member WHERE member.id = queued.member_id),queued.event_type,queued.category)
       AND queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.created_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id, queued.title,
       queued.body, queued.data || jsonb_build_object('notificationEvent',queued.event_type,'outboxId',queued.id) AS data, queued.category
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id, claimed.title,
    claimed.body, claimed.data, claimed.category
  FROM claimed;
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
