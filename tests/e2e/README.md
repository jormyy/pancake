# Multi-Season E2E Harness

This harness is the Phase C entrypoint for dynasty soak testing. It starts the fake NBA CDN/Sleeper server on port `4555`, points the app stack at that server through `NBA_CDN_BASE_URL` and `SLEEPER_BASE_URL`, snapshots dynasty-critical tables, and runs D.0 invariant checks at season boundaries.

The runner loads `.env` and `backend/.env` automatically. Existing app variables are accepted as fallbacks:

- `SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_URL`
- `PANCAKE_SUPABASE_SECRET_KEY` or `SUPABASE_SECRET_KEY` with the dashboard-revealed `sb_secret_...` value, not the Supabase Management API metadata ID
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_API_URL`

Legacy Supabase service-role JWT keys are not accepted. Legacy anon JWTs remain read-only public-key fallbacks while the hosted project migration is in progress: `EXPO_PUBLIC_SUPABASE_ANON_KEY` and `E2E_SUPABASE_ANON_KEY`.

Explicit E2E overrides are still supported:

```sh
export E2E_SUPABASE_URL=...
export E2E_PANCAKE_SUPABASE_SECRET_KEY=sb_secret_...
export E2E_SUPABASE_SECRET_KEY=sb_secret_...
export E2E_SUPABASE_PUBLISHABLE_KEY=...
export E2E_SUPABASE_ANON_KEY=... # legacy fallback only
export E2E_API_BASE_URL=http://127.0.0.1:3000
export E2E_FRONTEND_URL=http://127.0.0.1:8081
export E2E_ADMIN_SECRET=...
export E2E_ENABLE_BACKEND_TICKS=1
export E2E_ENABLE_BROWSER_AUTH=1
export E2E_BROWSER_AUTH_USERS=10
export E2E_ENABLE_BROWSER_GAMEPLAY=1
export E2E_ENABLE_BROWSER_WAIVER=1
export E2E_ENABLE_LEAGUE_LIFECYCLE=1
export E2E_ENABLE_PICK_CHAIN=1
export E2E_ENABLE_PUSH=1
export E2E_ENABLE_DRAFT_PUSH=1
export E2E_ENABLE_REALTIME=1
export E2E_ENABLE_MIDLIFE_MIGRATION=1
export E2E_ENABLE_AUCTION=1
export E2E_ENABLE_PLAYOFFS=1
export E2E_ENABLE_TIEBREAKERS=1
export E2E_ENABLE_SETTINGS=1
export E2E_ENABLE_SCORING=1
export E2E_ENABLE_INJURY_FILTER=1
export E2E_ENABLE_TRADE_ACCEPT=1
export E2E_ENABLE_ROOKIE_DRAFT=1
export E2E_ENABLE_SEASON_RESET=1
export E2E_PERF_DRIFT_LIMIT=1.2
export E2E_MEMORY_DRIFT_LIMIT=1.2
export NBA_CDN_BASE_URL=http://127.0.0.1:4555/static/json
export SLEEPER_BASE_URL=http://127.0.0.1:4555/v1
export EXPO_PUSH_URL=http://127.0.0.1:4555/--/api/v2/push/send
```

Run:

```sh
npm run e2e:seed
npm run e2e:soak
```

`e2e:seed` writes `tests/e2e-state.json` with the isolated league and test users for the latest run. The file is ignored because it contains local test credentials. `e2e:soak` automatically scopes invariant checks and snapshots to that league, or you can override it with `E2E_LEAGUE_ID`.

Backend tick routes are available only when the Fastify server is started with both `ENABLE_E2E_ROUTES=1` and `E2E_ADMIN_SECRET`. The soak runner calls them only when `E2E_ENABLE_BACKEND_TICKS=1`. In that mode it runs sync/admin ticks and calls the real season-reset path for the target league at each season boundary, then re-checks invariants including the rolling five-year pick-bank horizon.

Backend tick mode also checks D.X.3 CORS behavior before the season loop. It sends an `OPTIONS` preflight to `/e2e/status` with the configured `E2E_FRONTEND_URL` origin and verifies the response allows the origin, `GET`, and the headers used by the app/E2E routes.

When backend ticks are enabled, the runner also checks D.SEA.1 matchup generation idempotency for the target league. It counts current-season `matchups`, calls `/e2e/generate-matchups` a second time with `force: false`, and fails if the count changes or if a league with enough members has no generated schedule.

Snapshots are written under `tests/snapshots/season-<N>/` after the season boundary checks. When backend ticks are enabled, snapshots are written after the real season reset. Each snapshot includes a `summary.json`, and the runner fails D.SEA.7 if any dynasty-critical table count shrinks across seasons or if `draft_picks`, `league_seasons`, or `waiver_priorities` fail to grow after real resets.

Performance metrics are written to `tests/artifacts/perf-metrics.json`. Runs shorter than 10 seasons record timings and harness memory only. Runs of 10+ seasons fail D.LONG.6 if the latest season runtime is more than `E2E_PERF_DRIFT_LIMIT` above season 1; the default is `1.2` for the requested 20% drift ceiling. Runs of 10+ seasons also fail D.LONG.7 if harness RSS or heap memory exceeds `E2E_MEMORY_DRIFT_LIMIT` above season 1; the default is also `1.2`. The RSS gate has an `E2E_MEMORY_DRIFT_MIN_BYTES` absolute floor, defaulting to 48 MiB, to avoid failing on Node allocator high-water noise while still catching material native growth. The heap gate has a separate `E2E_MEMORY_HEAP_DRIFT_MIN_BYTES` floor, defaulting to 24 MiB, so retained JS object growth remains a stricter leak signal.

League lifecycle checks are available with `E2E_ENABLE_LEAGUE_LIFECYCLE=1` or `--league-lifecycle=true`. The runner signs in as the seeded users through Supabase Auth, calls the real authenticated `create_league` RPC for user 1, joins users 2-10 through the real `join_league_by_invite_code` RPC, and verifies the invite code, 10 league members with roles, one current season, default lineup slot templates, and five years of three-round draft picks for every member. Artifacts are written to `tests/artifacts/season-<N>/league-lifecycle.json`. This covers the D.SET.2 create/join/pick-bank slice through real anon clients; browser form entry remains separate.

Future-pick chain checks are available with `E2E_ENABLE_PICK_CHAIN=1` or `--pick-chain=true`. The runner creates three accepted pick-only trades for one five-years-out round-one pick, persists the scenario metadata to `tests/artifacts/future-pick-chain.json`, and checks at every season boundary that the exact `draft_picks.current_owner_id` remains the final multi-hop owner. Once the target pick reaches its draft year during a backend-tick run, the runner starts the real rookie draft and verifies the linked `snake_draft_picks.draft_pick_id` slot belongs to the final traded owner; the slot artifact is written to `tests/artifacts/season-<N>/rookie-draft-pick-chain.json`. This covers D.LONG.1/D.LONG.2 ownership-drift invariants through the real `accept_trade_atomic` and rookie-draft seeding paths; it is not a replacement for the full browser trade or rookie-draft workflow.

Auction bid validation is available with `E2E_ENABLE_AUCTION=1` or `--auction=true`. The runner creates a disposable auction draft/nomination in the seeded league, calls the real service-role-only `place_auction_bid_atomic` RPC, verifies `<= current`, over-budget, and self-overbid attempts are rejected, then verifies two valid bids leave the second bidder as high bidder. Artifacts are written to `tests/artifacts/season-<N>/auction-validation.json`. This covers the server-side bid validation slice of D.SET.4; it does not replace the full browser-driven auction draft.

Playoff bracket checks are available with `E2E_ENABLE_PLAYOFFS=1` or `--playoffs=true`. The runner creates a disposable 10-team league from the seeded users, inserts deterministic finalized regular-season matchups, signs in as the seeded commissioner, calls the real authenticated `/playoffs/generate` route, verifies `/playoffs/advance` blocks before prerequisite games are finalized, and checks that a 10-team league gets a top-6 bracket with seeds 1 and 2 on bye. Artifacts are written to `tests/artifacts/season-<N>/playoff-bracket.json`. This covers the bracket-generation slice of D.SEA.4; champion crowning through completed playoff gameplay remains pending.

Standings tiebreaker checks are available with `E2E_ENABLE_TIEBREAKERS=1` or `--tiebreakers=true`. The runner creates disposable four-team leagues from seeded users, forces equal wins and points-for, calls the real authenticated `/playoffs/generate` route, verifies max-possible-points affects playoff seeding before points-against, then forces a full four-way tie and checks that completed `rps_challenges` audit rows are created while deterministic playoff seeding still succeeds. Artifacts are written to `tests/artifacts/season-<N>/standings-tiebreakers.json`. This covers the D.SEA.3 backend seeding/tiebreaker slice.

Commissioner settings checks are available with `E2E_ENABLE_SETTINGS=1` or `--settings=true`. The runner creates a disposable league from seeded users, signs in through Supabase Auth as the commissioner and a manager, updates league/scoring/lineup-slot settings through the anon client under real RLS, verifies the manager can read the propagated settings, and verifies a manager write attempt does not mutate commissioner-only league settings. The scoring assertion uses the schema-valid `triple_double` key for the prompt's triple-double bonus because the live schema rejects `triple_double_bonus`. Artifacts are written to `tests/artifacts/season-<N>/commissioner-settings.json`. This covers the D.SET.3 propagation/RLS slice; browser editing of the settings form remains pending.

Weekly scoring/finalization checks are available with `E2E_ENABLE_SCORING=1` or `--scoring=true`. The backend must be running with `ENABLE_E2E_ROUTES=1` and `E2E_ADMIN_SECRET`; the runner creates a disposable two-team league, seeds a current `season_weeks` row, one NBA game, starter and bench `weekly_lineups`, and real `player_game_stats`, then calls `/e2e/sync-scores`. It verifies only starters count, a Scheduled game blocks finalization, a Final game finalizes the matchup with the correct winner, `max_possible_points` is persisted, and standings rows are appended. Artifacts are written to `tests/artifacts/season-<N>/weekly-scoring-finalization.json`. This covers the starter-only scoring/finalization slice of D.SEA.2; browser lineup setting, waivers, and trades remain pending.

Waiver processing checks are available with `E2E_ENABLE_WAIVER_PROCESSING=1` or `--waiver-processing=true`. The backend must be running with `ENABLE_E2E_ROUTES=1` and `E2E_ADMIN_SECRET`; the runner creates a disposable four-team league, seeds priority-ordered competing claims, a drop-then-add claim, and a full-roster/no-drop claim, then calls `/e2e/process-waivers`. It verifies priority order, lower-priority failure, winner-to-back reseeding, drop-player waiver logging, waiver transactions, roster movement, and `failed_roster`. Artifacts are written to `tests/artifacts/season-<N>/waiver-processing.json`. This covers the priority/daily-processing slice of D.SEA.2; browser claim entry is covered by the separate browser waiver scenarios.

Sleeper injury-status filtering checks are available with `E2E_ENABLE_INJURY_FILTER=1` or `--injury-filter=true`. The backend must be running with `ENABLE_E2E_ROUTES=1`, `E2E_ADMIN_SECRET`, and `SLEEPER_BASE_URL=http://127.0.0.1:4555/v1`; the runner creates controlled player rows for the fake Sleeper fixtures, mutates one upstream player to `Scrambled` and another to `Out`, calls `/e2e/sync-players`, and verifies `Scrambled` is filtered to null while `Out` persists. Artifacts are written to `tests/artifacts/season-<N>/injury-status-filter.json`. This covers the injury injection/filter slice of D.SEA.2; broader injury-driven roster/IR gameplay remains pending.

Trade acceptance atomicity checks are available with `E2E_ENABLE_TRADE_ACCEPT=1` or `--trade-accept=true`. The backend must be reachable through `E2E_API_BASE_URL`; the runner creates a disposable two-team league, rosters one player per team, creates one future pick per team, inserts a pending player+pick trade, verifies a mismatched auth/member accept is rejected by the real `/trades/:tradeId/accept` route, accepts as the real recipient, verifies assets stay put while the veto window is open, expires the window, runs `/e2e/process-trades`, and checks player ownership, pick ownership, trade completion timestamps, and trade transaction rows. Artifacts are written to `tests/artifacts/season-<N>/trade-acceptance-atomicity.json`. This covers the backend acceptance/atomicity slice of D.SEA.2; proposal/reject/withdraw/veto browser flows remain pending.

Trade veto threshold checks are available with `E2E_ENABLE_TRADE_VETO=1` or `--trade-veto=true`. The runner seeds accepted trades with an open veto window, verifies trade parties cannot cast member vetoes, verifies three of eight non-party vetoes do not kill a trade, verifies the fourth veto reaches the 50% threshold and marks the trade `vetoed`, and verifies a commissioner veto kills a trade immediately. Artifacts are written to `tests/artifacts/season-<N>/trade-veto-threshold.json`. This covers backend veto rule enforcement; the app still needs full accepted-state UI and delayed-completion lifecycle coverage.

Rookie draft checks are available with `E2E_ENABLE_ROOKIE_DRAFT=1` or `--rookie-draft=true`. The backend must be running with `ENABLE_E2E_ROUTES=1` and `E2E_ADMIN_SECRET`; the runner creates a disposable offseason league, seeds previous-season standings and exact `draft_picks`, starts the real rookie draft through `/e2e/start-rookie-draft`, verifies inverse-standings snake slot order and linked pick assets, runs `/e2e/:draftId/auto-pick`, and checks lowest-`nba_draft_number` selection, immediate `picked_at`, linked pick-asset usage, roster insert, and already-rostered rejection through the authenticated `/draft/:draftId/snake-pick` route. Artifacts are written to `tests/artifacts/season-<N>/rookie-draft-auto-pick.json`. This covers the D.SEA.5 order/auto-pick/rejection slice; browser timer behavior and long-horizon traded-pick materialization remain separate.

Browser rookie draft auto-pick gameplay is available through `npm run e2e:browser-rookie-draft` or `E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1 npm run e2e:soak`. It creates an isolated four-user offseason league, seeds previous-season standings plus linked current-year `draft_picks`, opens the real rookie draft room through `agent-browser` as the first pick owner, lets the 30-second visible timer expire, and verifies the browser-triggered auto-pick selected the lowest `nba_draft_number`, inserted the roster row, and marked the exact linked pick asset used. Artifacts are written to `tests/artifacts/season-<N>/browser-rookie-draft/`. This covers the D.SEA.5 browser timer/auto-pick slice; long-horizon traded-pick materialization remains covered by `E2E_ENABLE_PICK_CHAIN=1`.

Browser playoff champion gameplay is available through `npm run e2e:browser-playoff` or `E2E_ENABLE_BROWSER_PLAYOFF=1 npm run e2e:soak`. It creates an isolated 10-user league, seeds deterministic regular-season results, generates the real top-six playoff bracket through `/playoffs/generate`, verifies `/playoffs/advance` blocks before prerequisite rounds finalize, finalizes quarterfinals/semifinals/championship rows, then opens the real bracket modal through `agent-browser` and verifies the champion banner. Artifacts are written to `tests/artifacts/season-<N>/browser-playoff/`. This covers the D.SEA.4 champion display and playoff advancement slice; full week-by-week playoff scoring remains covered by backend scoring/finalization slices.

Season reset checks are available with `E2E_ENABLE_SEASON_RESET=1` or `--season-reset=true`. The backend must be running with `ENABLE_E2E_ROUTES=1` and `E2E_ADMIN_SECRET`; the runner creates a disposable active league, seeds standings, waiver priorities, roster rows with IR/taxi flags, old-season lineups/matchups, and a rolling five-year pick bank, then calls the real `/e2e/advance-season` endpoint. It verifies exactly one current season, old-season demotion, roster carryover, `carry_over` acquisition stamps, waiver priority reseed by reverse standings, old-season history queryability, league offseason status, and the new rolling five-year pick horizon. Artifacts are written to `tests/artifacts/season-<N>/season-reset.json`. This covers the deterministic D.SEA.6 reset/carryover/reseed slice; crash-in-the-middle rollback still needs a fault-injection scenario.

Push notification interception is available with `E2E_ENABLE_PUSH=1` or `--push=true`. The Fastify backend must be started with `EXPO_PUSH_URL=http://127.0.0.1:4555/--/api/v2/push/send`; the runner fails closed if `/e2e/status` reports any other push URL. Each season seeds a recipient's `profiles.push_token`, seeds a real pending waiver claim, runs `/e2e/process-waivers`, and asserts the fake upstream captured the server-emitted Expo push payload. Artifacts are written to `tests/artifacts/season-<N>/push-notifications.json`. This covers the waiver notification slice of D.X.1. (Trade-push delivery is exercised by the real `/trades/*` routes' server-side notifications during the main soak; the former direct `/notify/trade` injection endpoint was removed as an abuse surface.)

Draft push interception is available with `E2E_ENABLE_DRAFT_PUSH=1` or `--draft-push=true`. The backend must be running with `ENABLE_E2E_ROUTES=1`, `E2E_ADMIN_SECRET`, and the fake `EXPO_PUSH_URL`; the runner creates a disposable offseason rookie draft, sets the first pick owner's `profiles.push_token`, runs the real `/e2e/:draftId/auto-pick` path, and asserts the fake upstream captured a draft notification for that token. Artifacts are written to `tests/artifacts/season-<N>/draft-push-notification.json`. This covers the draft-event notification slice of D.X.1 independently from the waiver processor.

Standings/champion history retention is available with `E2E_ENABLE_HISTORY=1` or `--history=true` in backend tick mode. Each season seeds deterministic completed-season standings plus a finalized playoff-final row for the season about to reset, advances the season through the real backend, then verifies all previously seeded standings and champions remain queryable. Artifacts are written to `tests/artifacts/season-<N>/history-retention.json`. This covers the D.LONG.3/D.LONG.4 history-retention slice only; it does not replace full playoff gameplay.

Realtime latency checks are available with `E2E_ENABLE_REALTIME=1` or `--realtime=true`. The runner opens `E2E_REALTIME_CLIENTS` Supabase Realtime clients (default 10) as seeded users, subscribes each one to a disposable `matchups` row update, updates that row through the service-role client, and fails if every subscribed client does not receive the update within `E2E_REALTIME_LATENCY_LIMIT_MS` (default 2000). Subscription setup has its own `E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS` (default 10000). Artifacts are written to `tests/artifacts/season-<N>/realtime-latency.json`. This covers the matchups-update slice of D.X.2; bid-room realtime still requires a draft-room scenario.

Mid-life migration checks are available with `E2E_ENABLE_MIDLIFE_MIGRATION=1` or `--midlife-migration=true`. The runner applies Supabase migrations with `npx supabase db push` between seasons 5 and 6 by default; it uses `--local` when the configured Supabase URL is localhost, otherwise `--linked`. Override with `E2E_MIDLIFE_MIGRATION_TARGET=local|linked`, `E2E_MIDLIFE_MIGRATION_DB_URL`, or `E2E_MIDLIFE_MIGRATION_AFTER_SEASON`. The checked-in migration `20260512000009_e2e_midlife_noop.sql` intentionally changes no application tables, so this gate verifies deployment/migration continuity without masking gameplay failures. Artifacts are written to `tests/artifacts/season-<N>/midlife-migration.json`.

Browser smoke runs are available through `npm run e2e:browser-smoke` or `E2E_ENABLE_BROWSER=1 npm run e2e:soak`. They use `agent-browser` with an isolated session, sign in as the seeded commissioner, visit the main tab screens, and write screenshots plus console/error logs under `tests/artifacts/season-<N>/smoke/`. Screenshots are required by default; set `E2E_BROWSER_SKIP_SCREENSHOTS=1` only for local runs where the `agent-browser screenshot` transport is known to be unhealthy. Set `E2E_BROWSER_FULL_SWEEP=1` or `--browser-full-sweep=true` with browser mode to also visit auth, modal, player, auction-draft, and rookie-draft routes (`sign-in`, `sign-up`, `create-league`, `join-league`, `commissioner-settings`, `lineup`, `bracket`, `claim-player`, `player/[id]`, `propose-trade`, `team-roster`, `draft-room`, `rookie-draft-room`). When the seeded league has no draft rows, the sweep creates minimal disposable draft fixtures so the route-load check cannot silently skip those screens. This covers the D.X.5 route-load slice; the full D.SET/D.SEA/D.X/D.LONG gameplay loop remains separate work.

Browser auth runs are available through `npm run e2e:browser-auth` or `E2E_ENABLE_BROWSER_AUTH=1 npm run e2e:soak`. They use isolated `agent-browser` sessions for seeded users, verify a protected route redirects to sign-in, sign in, verify profile/session persistence, sign out through the real profile UI, and verify the auth guard returns. Set `E2E_BROWSER_AUTH_USERS=10` to exercise all seeded users in parallel. This covers D.SET.1 only; it does not replace auction, trade, waiver, lineup, playoff, or rookie-draft browser scenarios.

Browser auction gameplay is available through `npm run e2e:browser-gameplay` or `E2E_ENABLE_BROWSER_GAMEPLAY=1 npm run e2e:soak`. It creates an isolated two-user league, signs into Expo web through `agent-browser`, opens the real auction draft room as the bidder, clicks the visible bid button, and verifies the backend/RPC persisted the high bid and bid history row. This covers the first D.SET.4 UI gameplay slice; full auction completion, timer expiry, and reconnect behavior remain separate work.

Browser lineup gameplay is available through `npm run e2e:browser-lineup` or `E2E_ENABLE_BROWSER_LINEUP=1 npm run e2e:soak`. It creates an isolated one-user league, rosters a PG-eligible player, signs into Expo web through `agent-browser`, opens the real lineup modal, moves the bench player into an empty PG starter slot, and verifies a non-auto `weekly_lineups` row persisted. Browser auto-set lineup gameplay is available through `npm run e2e:browser-lineup-auto-set` or `E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1 npm run e2e:soak`; it opens the real Auto-Set modal, chooses Today, and verifies an auto-set `weekly_lineups` row persisted. This covers the first manual and auto-set lineup slices; locked-player moves remain separate work.

Browser waiver gameplay is available through `npm run e2e:browser-waiver` or `E2E_ENABLE_BROWSER_WAIVER=1 npm run e2e:soak`. It creates an isolated one-user league, places a player on the real waiver wire, signs into Expo web through `agent-browser`, opens the real claim-player modal, submits a no-drop waiver claim, and verifies the backend persisted a pending `waiver_claims` row. Browser drop-then-add waiver gameplay is available through `npm run e2e:browser-waiver-drop` or `E2E_ENABLE_BROWSER_WAIVER_DROP=1 npm run e2e:soak`; it creates an isolated full-roster league, selects a real roster player to drop, submits the claim, and verifies the persisted `drop_player_id`. Browser DTD-on-IR blocking is available through `npm run e2e:browser-waiver-ir-block` or `E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1 npm run e2e:soak`; it seeds a DTD player onto IR, opens the real claim-player modal, verifies the blocking UI, and checks no claim row is inserted. This covers the first D.SEA.2 waiver UI gameplay slices; priority processing and daily processing remain separate work.

Browser trade proposal gameplay is available through `npm run e2e:browser-trade` or `E2E_ENABLE_BROWSER_TRADE=1 npm run e2e:soak`. It creates an isolated two-user league, seeds one rostered player per team, signs into Expo web through `agent-browser`, opens the real propose-trade modal, selects both player rows, submits the proposal through the authenticated Fastify route, and verifies one pending `trades` row with the expected proposer/recipient `trade_items`. This covers the first D.SEA.2 trade proposal UI slice; accept/veto, future-pick proposal UI, atomic completion, and post-deadline rejection remain separate work.

Browser future-pick trade proposal gameplay is available through `npm run e2e:browser-trade-future-pick` or `E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1 npm run e2e:soak`. It creates an isolated two-user league, signs into Expo web through `agent-browser`, opens the real propose-trade modal, selects each team's five-years-out round-one pick by accessible label, submits the proposal through the authenticated Fastify route, and verifies pending pick `trade_items` without moving pick ownership before acceptance. This covers the future-pick proposal UI slice; veto, future-pick acceptance through the browser, overflow drop-before-accept, and post-deadline rejection remain separate work.

Browser future-pick trade acceptance gameplay is available through `npm run e2e:browser-trade-future-pick-accept` or `E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1 npm run e2e:soak`. It creates an isolated pending five-years-out pick-for-pick trade, signs into Expo web through `agent-browser` as the recipient, opens the real Trades Offers tab, taps the accessible accept action, verifies the accepted veto-window state, expires/completes the window through the service-role test helper, and verifies `draft_picks.current_owner_id` swaps while rostered players and `roster_transactions` stay untouched. This covers the future-pick accept UI slice; accepted-state veto UI, overflow drop-before-accept, and post-deadline rejection remain separate work.

Browser trade overflow acceptance gameplay is available through `npm run e2e:browser-trade-overflow-accept` or `E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1 npm run e2e:soak`. It creates an isolated mixed player/future-pick trade with the recipient at a one-player roster cap, signs into Expo web through `agent-browser`, opens the real Trades Offers tab, triggers the drop-before-accept modal, drops the current rostered player, verifies the accepted veto-window state, expires/completes the window through the service-role test helper, and verifies the trade completes while the dropped player is logged to waivers. This covers the overflow drop-before-accept UI slice; accepted-state veto UI, post-deadline rejection, and waiver processing remain separate work.

Browser post-deadline trade rejection gameplay is available through `npm run e2e:browser-trade-post-deadline` or `E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1 npm run e2e:soak`. It creates an isolated league with `trade_deadline` in the past, signs into Expo web through `agent-browser`, attempts the real propose-trade flow, and verifies the authenticated Fastify proposal route rejects the request without inserting `trades` or `trade_items`. This covers the post-deadline rejection slice; veto and waiver processing remain separate work.

Browser trade veto gameplay is available through `npm run e2e:browser-trade-veto` or `E2E_ENABLE_BROWSER_TRADE_VETO=1 npm run e2e:soak`. It creates an isolated three-user league with an accepted trade in an open veto window, signs into Expo web through `agent-browser` as a non-party member, opens the real Trades Offers tab, taps the accessible veto action, and verifies the authenticated backend records one member veto, marks the trade vetoed at threshold, and leaves roster assets unmoved. This covers the accepted-state veto UI slice; broader multi-voter browser behavior and waiver processing remain separate work.

Browser trade acceptance gameplay is available through `npm run e2e:browser-trade-accept` or `E2E_ENABLE_BROWSER_TRADE_ACCEPT=1 npm run e2e:soak`. It creates an isolated pending player-for-player trade, signs into Expo web through `agent-browser` as the recipient, opens the real Trades Offers tab, taps the accessible accept action, verifies the accepted veto-window state, expires/completes the window through the service-role test helper, and verifies the trade moves both rostered players and writes trade transaction rows. This covers the first D.SEA.2 trade accept UI slice; reject/withdraw, broader veto UX, future-pick UI acceptance, overflow drop-before-accept, and post-deadline rejection remain separate work.

Browser trade reject/withdraw gameplay is available through `npm run e2e:browser-trade-terminal` or `E2E_ENABLE_BROWSER_TRADE_TERMINAL=1 npm run e2e:soak`. It creates two isolated pending player-for-player trades, signs into Expo web through `agent-browser` as the recipient to reject one and as the proposer to withdraw the other, confirms through the web confirmation path, and verifies the authenticated Fastify routes set `rejected` and `withdrawn` without moving rostered players or writing trade transaction rows. This covers the first D.SEA.2 terminal trade action UI slice; veto, future-pick UI acceptance, overflow drop-before-accept, and post-deadline rejection remain separate work.

Outputs:

- `tests/e2e-report.md`
- `tests/e2e-coverage.md`
- `tests/e2e-seed-report.md`
- `tests/e2e-state.json`
- `tests/e2e-browser-report.md`
- `tests/e2e-browser-auth-report.md`
- `tests/e2e-browser-gameplay-report.md`
- `tests/e2e-browser-playoff-report.md`
- `tests/e2e-browser-rookie-draft-report.md`
- `tests/e2e-browser-lineup-report.md`
- `tests/e2e-browser-waiver-report.md`
- `tests/e2e-browser-waiver-drop-report.md`
- `tests/e2e-browser-waiver-ir-block-report.md`
- `tests/artifacts/perf-metrics.json`
- `tests/artifacts/future-pick-chain.json`
- `tests/snapshots/season-<N>/`
- `tests/snapshots/season-<N>/summary.json`
- `tests/artifacts/season-<N>/`
- `tests/artifacts/season-<N>/auction-validation.json`
- `tests/artifacts/season-<N>/waiver-processing.json`
- `tests/artifacts/season-<N>/league-lifecycle.json`
- `tests/artifacts/season-<N>/playoff-bracket.json`
- `tests/artifacts/season-<N>/standings-tiebreakers.json`
- `tests/artifacts/season-<N>/commissioner-settings.json`
- `tests/artifacts/season-<N>/weekly-scoring-finalization.json`
- `tests/artifacts/season-<N>/injury-status-filter.json`
- `tests/artifacts/season-<N>/trade-acceptance-atomicity.json`
- `tests/artifacts/season-<N>/rookie-draft-auto-pick.json`
- `tests/artifacts/season-<N>/season-reset.json`
- `tests/artifacts/season-<N>/draft-push-notification.json`
- `tests/artifacts/season-<N>/push-notifications.json`
- `tests/artifacts/season-<N>/midlife-migration.json`
- `tests/artifacts/season-<N>/rookie-draft-pick-chain.json`

The runner fails closed when the real test Supabase/backend/frontend environment is missing or when the linked Supabase project is missing required post-refactor RPCs/columns. A `PARTIAL` report means only the enabled subset passed, usually fake-upstream/database boundary checks without the full browser scenario set. The current source-of-truth dynasty proof is a `PASS` report in `tests/e2e-report.md` from the all-flags 20-season run with browser, backend, Supabase, realtime, push, and long-horizon slices enabled.
