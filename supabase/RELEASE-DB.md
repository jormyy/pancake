# Release database contract

## Server review corrections — 2026-10-24

### Decision

Nine findings are fixed within the permitted files.
C4 is partly fixed because waiver queueing needs two excluded canonical SQL files.
Integration still needs the test, catalog, and type updates below.
No files are staged or committed.
Every database check runs in one transaction that rolls back.

### Findings

| Item | Result | Changed behavior or remaining work |
| --- | --- | --- |
| C14 | Fixed | Certified, unchanged weeks skip finalization. Planning no longer adds the previous week. Generated scoring code matches its source. |
| C24 | Fixed | Unchanged matchups and standings avoid updates. Existing waiver priority stays fixed. Real score changes still update timestamps. Certificates still refresh. |
| C25 | Fixed | Reconciliation locks a materialized batch before joining responses. The join bounds response creation time by the batch's earliest queued time. |
| C26 | Fixed | Internal game progress fields no longer emit league hints. Visible game changes still emit hints. |
| C4 | Partly fixed | Web delivery returns recipient outcomes. Success, absent subscriptions, and gone subscriptions complete. Temporary failures back off. Permanent failures dead-letter. Waiver queueing remains open. |
| C5 | Fixed | CDN resolver maps and their parameters are removed. Each call still checks canonical identity through the RPC. Stale comments are removed. |
| C8 | Fixed | Edge sends an empty schedule payload and loads no members. SQL owns scheduling. The unused round-robin code and its tests are removed. |
| C28 | Fixed | Six unused functions and the retired source-state table are dropped. The obsolete cache assertions are removed. Both release compatibility routines remain. |
| C29 | Fixed | Inventory hint draining runs every thirty seconds. Its command stays the same. |
| C30 | Fixed | The false Monday-only comment is removed from the canonical function and its new migration copy. |

The Expo sender, ticket recording caller, receipt worker, and push-token routes are removed.
Pending Expo tickets return to the web delivery queue through a migration.
Generic web push payloads retain their existing account privacy behavior.
No SQL signatures or grants change.
The Edge matchup helper keeps its old argument shape for callers outside this scope.

### Tests

| Scope | Result |
| --- | --- |
| `npm run check:quality` | Pass |
| Targeted Deno checks below | 49 pass, zero fail |
| Adjacent Deno checks below | 55 pass, eight obsolete expectations fail |
| `npm run check:edge-functions` | All seventeen entrypoints type-check; test compilation stops on eight errors in excluded resolver and Expo test files |
| Targeted Vitest files below | Nine pass, one obsolete receipt expectation fails |
| Scoped SQL files below | Fourteen files pass, zero fail |
| `npm run check:db-function-catalog` | Fails because the protected manifest still lists the six dropped functions |
| `git diff --check` | Pass |

The passing targeted Deno files are:

- `supabase/functions/_shared/notifications.test.ts`: seven tests.
- `supabase/functions/_shared/notificationWebPush.test.ts`: five tests.
- `supabase/functions/process-trades/outbox.test.ts`: eight tests.
- `supabase/functions/_shared/playerResolver.test.ts`: four tests.
- `supabase/functions/api/matchups.test.ts`: four tests.
- `supabase/functions/live-poll/scoreSync.test.ts`: nine tests.
- `supabase/functions/_shared/cdnGameFetch.test.ts`: three tests.
- `supabase/functions/_shared/backfillJobs.test.ts`: two tests.
- `supabase/functions/_shared/webPush.test.ts`: seven tests.

The adjacent Deno files are:

- `supabase/functions/_shared/finalizationWrite.test.ts`: five pass.
- `supabase/functions/_shared/octoberGap.test.ts`: three pass.
- `supabase/functions/_shared/scoringCalendar.test.ts`: one pass.
- `supabase/functions/_shared/syncScoresFanout.test.ts`: three pass.
- `supabase/functions/_shared/syncStats.concurrency.test.ts`: one pass.
- `supabase/functions/_shared/syncStats.contention.test.ts`: three pass.
- `supabase/functions/_shared/syncStats.test.ts`: twenty pass.
- `supabase/functions/_shared/scoreCertifiedMax.test.ts`: three pass, four fail on superseded planning assumptions.
- `supabase/functions/api/router.test.ts`: sixteen pass, four fail on removed Expo routes.

The Vitest command covers these files:

- `tests/edge-scheduling-contracts.test.ts`.
- `tests/trade-lazy-roster-browser-contract.test.ts`.
- `tests/trade-notification-outbox-contract.test.ts`.

Only the last file fails.
Its failed check requires the removed receipt worker.

The passing SQL files are:

- `tests/db/score-finalization-idempotence.sql`.
- `tests/db/edge-invocation-response-window.sql`.
- `tests/db/server-game-progress-hints.sql`.
- `tests/db/server-retired-functions.sql`.
- `tests/db/server-inventory-hint-cron.sql`.
- `tests/db/notification-web-push-requeue.sql`.
- `tests/db/edge-invocation-reconcile.sql`.
- `tests/db/player-search-cache-refresh.sql`.
- `tests/db/general-playoff-brackets.sql`.
- `tests/db/dynasty-rules.sql`.
- `tests/db/playoff-windows.sql`.
- `tests/db/skipped-week-certificates.sql`.
- `tests/db/advisory-access.sql`.
- `tests/db/correlated-dispatch.sql`.

Each SQL run applies the new migrations inside its rollback transaction.
The ticket recovery test applies its migration after creating its pending-ticket fixture.
No full application or database suite runs here.

### Failure proofs

The original scoring implementation fails both new skip checks.
The original notification implementation reports a successful web send as skipped.
The original matchup helper fails the SQL-delegation check by loading members.
Each implementation is restored after its failure proof.
The changed versions pass their tests.

All six new SQL files fail without their fixes and pass with them.
The failures cover unchanged writes, stale responses, internal hints, retired functions, cron timing, and pending tickets.
The first three checks explicitly restore the original function inside the rollback transaction.
The ticket check removes its new migration temporarily, observes failure, then restores it.
Comment removal and unused resolver cleanup do not change runtime behavior.

### Required changes outside this scope

| File | Required change |
| --- | --- |
| `supabase/sql/functions/by-name/public/claim_notification_outbox_atomic.sql` | Permit waiver rows in the claim filter. |
| `supabase/sql/functions/by-name/public/invoke_process_trades_if_due.sql` | Wake the worker for due waiver rows. |
| `supabase/functions/process-waivers/index.ts` | After the SQL changes, enqueue result notifications with a claim-based dedupe key. |
| New migration after those canonical updates | Copy both functions and allow the waiver category in the outbox constraint. |
| `supabase/functions/_shared/cdnBatch.test.ts` | Remove the old resolver import, construction, and third arguments. Five compile errors come from this file. |
| `supabase/functions/_shared/webPushDelivery.test.ts` | Retire its Expo delivery assertions or transfer its remaining checks. The allowed `notificationWebPush.test.ts` covers web fanout. |
| `supabase/functions/_shared/scoreCertifiedMax.test.ts` | Retire the superseded file or update its planning fixtures. The new live-poll test carries its correction coverage. |
| `supabase/functions/api/router.test.ts` | Remove obsolete Expo route tests and their route inventory entries. |
| `tests/trade-notification-outbox-contract.test.ts` | Replace the obsolete receipt-worker assertion with web retry coverage. |
| `supabase/tests/db/matchup-final-outbox.ts` | Replace its Expo provider and receipt fixture with web push. Remove its ticket-count assertion. This scenario is inspected but not run. |
| `docs/supabase-backend-route-inventory.md` | Remove the two retired Expo profile routes. |
| `supabase/sql/function-catalog.json` | Regenerate after the six function drops below. |
| `types/database.ts` | Regenerate to remove the four dropped public trade RPCs. |
| `package.json` | Wire the six new SQL files into scoped database checks and the integration database chain. |

`process-waivers/index.ts` itself is permitted.
It stays unchanged because enqueueing rows before the excluded claim and dispatch fixes leaves them undeliverable.
The outbox delivery helper already accepts waiver notifications.
Atomic waiver enqueueing can instead live in the claim transaction if its canonical SQL file is added to scope.

The dropped functions are:

- `public.counter_trade_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],uuid[],text,timestamptz,int,int)`.
- `public.counter_multi_team_trade_atomic(uuid,uuid,uuid,uuid[],jsonb,text,timestamptz)`.
- `public.edit_trade_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],uuid[],text,timestamptz,int,int)`.
- `public.edit_multi_team_trade_atomic(uuid,uuid,uuid,uuid[],jsonb,text,timestamptz)`.
- `private.ensure_season_faab_balances(uuid,uuid)`.
- `private.invalidate_player_search_cache()`.

The dropped table is `analytics.search_cache_source_state`.
`public.refresh_player_search_caches()` and `analytics.seed_league_fantasy_avgs(uuid)` remain for this release.

These retained SQL functions have no remaining live Edge caller after Expo removal:

- `public.record_notification_outbox_ticket_atomic`.
- `public.claim_notification_receipts_atomic`.
- `public.defer_notification_receipt_atomic`.
- `public.defer_notification_receipt_state_atomic`.
- `public.register_push_token_atomic`.
- `public.revoke_push_token_atomic`.
- `public.clear_push_token_for_user_atomic`.

Drop them in a later cleanup with their old SQL scenarios and protected catalog/type changes.
The current outbox completion, failure, and dead-letter RPCs remain live.

### Unmapped test selection

The selector reports several SQL and helper files as unmapped.
The SQL files above cover scoring, reconciliation, hints, cleanup, cron timing, and SQL scheduling.
The notification, outbox, web push, resolver, CDN fetch, and backfill tests cover the changed Edge helpers.
The new live-poll test is discovered by the existing Edge check.
No new Edge test command is needed.

### Open items

Complete waiver queueing after expanding the two canonical SQL paths.
Update the excluded tests and scenario before integration checks can pass.
Regenerate the protected catalog and types, then wire the new SQL checks.
No deployment or production access occurs here.

---

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
