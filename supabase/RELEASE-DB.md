# Release database contract

## Release order for this release

Database, then Edge, then merge the frontend.
Production currently stops at migration `20261028000200`.
Apply every migration below in order, through repository head `20261029000800`.
Keep published migrations unchanged.

| Migration | Change |
| --- | --- |
| `20261029000100_continuous_faab.sql` | Requires scheduled FAAB claims for every available player and freezes claim changes at the cutoff. |
| `20261029000200_inactive_trade_block.sql` | Applies inactive-trade settings to IR and taxi listings and preserves allowed listings during roster moves. |
| `20261029000300_trade_plan_moves_and_capacity.sql` | Adds retained-player moves, resulting-roster checks, shared reservations, and combined capacity checks to trade plans. |
| `20261029000400_trade_estimate_snapshots.sql` | Saves immutable trade quotes and attaches matching estimates during offer submission. |
| `20261029000500_matchup_forecasts.sql` | Adds cached matchup forecasts, private work claims, change triggers, member reads, and minute dispatch. |
| `20261029000600_historical_trade_revaluation.sql` | Revalues saved trades after ownership changes while preserving their original quotes. |
| `20261029000700_pre_tipoff_live_lock_compatibility.sql` | Uses compatible parent locks for lineup optimization and live statistics ingestion. |
| `20261029000800_matchup_forecast_lock_order.sql` | Locks forecast parents before the queue to prevent conflicts with scoring. |

Freeze the reviewed source and record the current frontend and Edge artifacts before release.
Refresh migration-range and database security attestations for this exact candidate.
[Migration history](../docs/production-migration-history.md#candidate-migrations) defines the baseline and approval boundaries.

Deploy these changed Edge functions after the database upgrade and before the frontend merge:

- `api`: Continuous claims, trade plans, saved estimates, and historical revaluation.
- `matchup-forecast`: Background forecast calculation and publication.
- `sync-sleeper-projections`: Selects the scoring week containing today and skips calendar gaps.

The source diff also includes `_shared`.
That directory contains bundled helpers and tests, rather than a deployable function.
Deploy its changed trade and forecast helpers with the functions above.
Confirm the function list from the reviewed candidate:

```sh
git diff --name-only origin/main...HEAD -- supabase/functions | cut -d/ -f3 | sort -u
```

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
Apply the ordered upgrade from `20261028000200` before exercising both deployed and candidate consumers.

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
If forecast dispatch must stop, unschedule `matchup-forecasts` and retain its queue and cache.
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

CREATE OR REPLACE FUNCTION public.invoke_process_trades_if_due()
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
      AND pending.expires_at <= now()
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= now()
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.available_at <= now()
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) THEN
    PERFORM public.invoke_edge_function('process-trades');
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
