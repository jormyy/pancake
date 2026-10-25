# Release database contract

## Changed RPC signatures

All existing positional calls work because the new arguments have defaults.
The old overloads are dropped to keep PostgREST calls clear.

```sql
public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid,
  p_to_ir boolean DEFAULT false
) RETURNS void

public.create_waiver_claim_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_bid_amount integer DEFAULT 0,
  p_claim_order integer DEFAULT NULL,
  p_to_ir boolean DEFAULT false
) RETURNS uuid

public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount integer DEFAULT 0,
  p_claim_order integer DEFAULT NULL,
  p_to_ir boolean DEFAULT false
) RETURNS void
```

| Code | Meaning |
| --- | --- |
| `PA006` | The requested free agent cannot enter IR. |
| `PA007` | The team's IR slots are full. |
| `PA005` | An existing IR player must leave IR before another add. |
| `PA001` | The weekly add limit is reached. |
| `PA003` | The active roster is full. |
| `P0001` | Existing season, game lock, or waiver rule rejection. The message gives the reason. |
| `42501` | The caller does not own the member. |
| `23505` | The free agent is already rostered. |
| `P0002` | The league or pending claim does not exist. |
| `22023` | A claim value is invalid. |

The add RPC stays available to authenticated users and the service role.
Claim create and edit stay limited to the service role through the authenticated API.
Both waiver API bodies accept `toIr: boolean`; an omitted value means false.
The claim row stores `waiver_claims.to_ir boolean NOT NULL DEFAULT false`.

An IR add keeps the active roster intact and consumes one weekly add.
It requires an Out or IR designation and an open IR slot.
The player can enter IR after his game starts.
It rejects offseason IR placement.
It never grants taxi access.

At award time, the server rechecks IR eligibility, capacity, and season state.
A started game does not block an IR award.
Moving a rostered player into or out of IR stays locked after tipoff.
An unavailable IR placement falls back to the active roster when capacity permits.
A full active roster fails the claim with `failed_roster` and a clear `failure_reason`.
An eligible IR award skips any stored drop selection.

## Changed RPC behavior with unchanged signatures

```sql
public.process_next_waiver_claim_atomic(p_process_date date)
public.get_league_projection_rows(
  p_league_id uuid,
  p_season_year integer DEFAULT public.current_season_year_et(),
  p_game_date date DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  p_view text DEFAULT 'today',
  p_player_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 600,
  p_offset integer DEFAULT 0
)
public.refresh_player_search_caches()
public.invoke_live_poll_if_due()
analytics.seed_league_fantasy_avgs(p_league_id uuid)
```

The projection RPC skips games marked InProgress or Final, or whose tipoff or start time has passed.
Its output columns stay the same.
The two cache routines return without rebuilding data.
The live gate returns at once when a current lease exists.
No new error codes apply to these routines.

## Player stats hint

The topic name is `player_stats` in `public.league_change_hints`.
The existing Realtime publication carries this row.
The payload has the usual row fields:

```json
{
  "league_id": "<league UUID>",
  "topic": "player_stats",
  "revision": 1,
  "scopes": null,
  "details": null,
  "updated_at": "<timestamp>"
}
```

A changed current-season stat queues a hint for each active or playoff league in that season.
Free-agent stat changes also queue hints.
A minute job sends at most one hint per minute for each league.
A suppressed final change stays queued until the next permitted flush.
Clients use the hint to refresh their visible player rows.
The hint contains no player pool or stat payload.

## Totals and score parity

`analytics.player_season_totals` keeps one row per player and season.
Statement triggers apply grouped deltas on insert, correction, and deletion.
The table includes minutes, all counting stats, makes, attempts, and bonus counts.
Separate value counts preserve the old NULL average behavior.
DNP lines and games outside the regular season do not contribute.
Game identity corrections rebuild only the affected players and seasons.
Game calendar corrections move totals through the existing stat correction path.

The existing average views now read live totals.
Search, dynasty reads, and projection fallback readers keep their output shapes.
League coefficients score the totals before sorting or paging.
Coefficients beyond two decimals use per-game scoring to preserve server rounding.
Unused double-double and triple-double coefficients still short-circuit.
Scoring itself continues to use the authoritative game lines.

## New private functions

These routines are server helpers, with execution limited to the database owner.
They are not client RPCs and add no custom error codes.

```sql
private.emit_player_stats_hint(p_years integer[]) RETURNS void
private.flush_player_stats_hints() RETURNS integer
private.maintain_player_season_totals() RETURNS trigger
private.rebuild_game_player_totals() RETURNS trigger
private.lock_deleted_stat_game() RETURNS trigger
private.clear_player_season_totals() RETURNS trigger
```

`private.reconcile_edge_invocations()` keeps its signature and skips unchanged response writes.

## Verification scope

The new checks cover IR rejection rules, weekly add accounting, and waiver award fallbacks.
They also cover an actual two-connection IR race and authenticated waiver API create and edit.
Projection checks cover status, tipoff, missing times, and a finished schedule.
The next-game check fails on the base database after tipoff.
The average parity oracle rejects altered expected scores and altered totals.
The hint check proves throttled changes stay queued for a later flush.

The load fixture and report are in `scripts/load/README.md`.
No iPhone screen verification runs in this database lane.

## Client handoff

- Add an eligible free agent with one `add_free_agent_atomic` call and `p_to_ir=true`.
- Send `toIr` in waiver create and edit bodies, and read the stored `to_ir` choice.
- Watch the `player_stats` topic through the existing league hint subscription.
- Refresh visible player rows when that topic changes.
- Keep server rule errors and waiver failure reasons visible to the user.
- Verify the combined release in the installed iPhone Safari app.

The old cache refresh no longer sends an averages resource notice.
The live stats hint replaces that notice.


## Final check results

| Command or scope | Result |
| --- | --- |
| `npm run test:db` from a fresh local reset | 154 commands pass; zero failures |
| Seventeen scoped database commands | Pass |
| `npm run check:edge-functions` | 254 tests pass; zero failures; four local-only tests skip here |
| Local-only Sleeper and retention checks in the database chain | Pass |
| Five scoped JavaScript contract files | 105 tests pass; zero failures |
| `npm run check:quality` | Pass |
| `npm run check:db-function-sources` | Pass |
| `npm run check:db-function-catalog` | Pass |
| `npm run check:database-types` | Pass |
| Base and changed load runs, plus both actual Realtime samples | Pass |
| `git diff --check` | Pass |

The database run uses the CI environment names and a locally served API.
Its keys come from the isolated stack's status output.
The base next-game check fails after a game starts; the changed check passes.
The parity checks reject changed expected scores and corrupt totals.
The old refresh notice test now checks the live stats notice and its actual Realtime delivery.
A test selector also runs both broader JavaScript suites; both commands pass.
Use explicit covering commands for unmapped paths to avoid that extra scope.

The local API and Supabase stack are stopped.
The original Supabase config is restored.
No files are staged or committed.
Do not repeat the full database run unless an integration change affects these paths.
The client integration and installed iPhone screen checks remain with the other lanes.

## Changed files

- `package.json`
- `scripts/load/README.md`
- `scripts/load/after.csv`
- `scripts/load/before.csv`
- `scripts/load/realtime-after.csv`
- `scripts/load/realtime-before.csv`
- `scripts/load/run.mjs`
- `scripts/load/seed.sql`
- `scripts/load/workload.sql`
- `supabase/RELEASE-DB.md`
- `supabase/functions/api/waivers.ts`
- `supabase/migrations/20261024000001_straight_to_ir.sql`
- `supabase/migrations/20261024000002_live_player_season_totals.sql`
- `supabase/migrations/20261024000003_reconciliation_writes_and_poll_gate.sql`
- `supabase/sql/function-catalog.json`
- `supabase/sql/functions/by-name/analytics/seed_league_fantasy_avgs.sql`
- `supabase/sql/functions/by-name/private/clear_player_season_totals.sql`
- `supabase/sql/functions/by-name/private/emit_player_stats_hint.sql`
- `supabase/sql/functions/by-name/private/flush_player_stats_hints.sql`
- `supabase/sql/functions/by-name/private/lock_deleted_stat_game.sql`
- `supabase/sql/functions/by-name/private/maintain_player_season_totals.sql`
- `supabase/sql/functions/by-name/private/rebuild_game_player_totals.sql`
- `supabase/sql/functions/by-name/private/reconcile_edge_invocations.sql`
- `supabase/sql/functions/by-name/public/add_free_agent_atomic.sql`
- `supabase/sql/functions/by-name/public/create_waiver_claim_atomic.sql`
- `supabase/sql/functions/by-name/public/edit_waiver_claim_atomic.sql`
- `supabase/sql/functions/by-name/public/get_league_projection_rows.sql`
- `supabase/sql/functions/by-name/public/invoke_live_poll_if_due.sql`
- `supabase/sql/functions/by-name/public/process_next_waiver_claim_atomic.sql`
- `supabase/sql/functions/by-name/public/refresh_player_search_caches.sql`
- `supabase/tests/db/league-change-hints.ts`
- `tests/db/fantasypros-projections.sql`
- `tests/db/live-player-stats-hints.sql`
- `tests/db/next-unstarted-game.sql`
- `tests/db/player-search-cache-refresh.sql`
- `tests/db/straight-to-ir-api.mjs`
- `tests/db/straight-to-ir-concurrency.mjs`
- `tests/db/straight-to-ir.sql`
- `types/database.ts`

## Next release

Keep the Expo objects while the deployed Edge release or its rollback can use them.
The client cannot update `profiles.push_token`; the service role keeps access.
The database phase also keeps receipt tickets and their current leases.

After the Web Push-only Edge release is live and its rollback window ends, add this follow-up migration:
`20261027000000_remove_legacy_expo_after_edge.sql`.
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
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.category IN ('trade','activity','waiver','draft')
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
       queued.body, queued.data, queued.category
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
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.category IN ('trade', 'activity', 'waiver', 'draft')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.available_at <= now()
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
