# E2E Coverage Checklist

- Run status: PARTIAL
- Started: 2026-05-12T08:30:36.939Z
- Finished: 2026-05-12T08:34:32.743Z
- Target seasons: 1

## Prompt-To-Artifact Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| Phase A audit report | PASS | tests/audit-report.md exists. |
| P0/P1 findings resolved | PARTIAL | Post-refactor deltas and approval-gated soak fixes are documented; external service-role rotation/history purge is still outside the repo. |
| Real test Supabase project | PASS | Supabase URL/service-role credentials loaded from E2E/app env. |
| Fake NBA CDN/Sleeper upstream | PASS | Fake upstream configured for http://127.0.0.1:4555. |
| D.SET.1 auth/session/sign-out | PASS | Browser auth scenario was enabled for this run. |
| D.SET.2 league create/join/pick bank | PARTIAL | Seeded target league 70c70f7e-737d-402d-ad1c-3fd204faac5e; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md. |
| D.SET.3 commissioner settings propagation | PARTIAL | Settings mode creates a disposable league, updates league/scoring/slot settings as the commissioner through Supabase RLS, verifies a manager can read them, and checks manager writes do not mutate commissioner-only settings. |
| D.SET.4 initial auction draft | PARTIAL | Auction mode creates a disposable auction nomination and verifies the atomic bid RPC rejects <=current, >budget, and self-overbid paths before accepting valid bids. |
| D.0 invariant boundary checks | PASS | Season rows in tests/e2e-report.md include D.0 boundary checks or failure. |
| D.SEA.1 matchup generation idempotency | PASS | Backend tick mode can call /e2e/generate-matchups twice and compare counts. |
| D.SEA.2 weekly lineup/scoring/waiver/trade loop | PARTIAL | Scoring mode seeds a disposable matchup with starter/bench lineups and real player_game_stats, calls the real backend /e2e/sync-scores path, and checks starter-only points, finalization blocking, winner, max-possible points, and standings append. |
| D.SEA.2 injury status filtering | PARTIAL | Injury-filter mode mutates the fake Sleeper upstream, runs the real backend /e2e/sync-players path, and verifies junk injury_status values such as Scrambled are filtered while valid statuses persist. |
| D.SEA.2 multi-asset trade acceptance | PARTIAL | Trade-accept mode creates a disposable player+future-pick trade, verifies mismatched auth/member acceptance is rejected, accepts through the real /trades/:tradeId/accept route, and checks players, picks, trade status, and transaction rows. |
| D.SEA.3 standings tiebreakers/RPS | PARTIAL | Tiebreaker mode seeds a disposable four-way tie and calls the real authenticated /playoffs/generate route to verify max-points/points-against/RPS handling. |
| D.SEA.4 playoffs/champion | PARTIAL | Playoff mode seeds a disposable 10-team regular season and calls the real authenticated /playoffs/generate route, then checks for a top-6 bracket. |
| D.SEA.5 rookie draft/traded picks | PARTIAL | Rookie-draft mode starts a disposable offseason draft through the real backend route, verifies inverse-standings snake order, auto-pick lowest nba_draft_number, exact pick asset usage, roster insert, and already-rostered rejection. |
| D.SEA.6 season reset | PARTIAL | Season-reset mode creates a disposable league, calls the real /e2e/advance-season endpoint, and verifies current-season flip, roster carryover, waiver reseed, prior-season queryability, and rolling five-year pick horizon. |
| D.SEA.7 snapshots/no shrink | PENDING | Snapshot summaries are written under tests/snapshots/season-<N>/summary.json. |
| D.X.1 push notifications | PARTIAL | Push mode verifies trade and waiver notifications through the fake Expo upstream; draft-push mode separately verifies rookie auto-pick notifications when enabled. |
| D.X.2 realtime bid/score events | PARTIAL | Realtime mode opens multiple Supabase Realtime clients and asserts a matchups update reaches every client within 2s. |
| D.X.3 CORS regression | PASS | Backend tick mode runs OPTIONS preflight before the season loop. |
| D.X.4 perf smoke under draft/live scoring load | PASS | Browser perf mode opens the real draft room and home scoreboard while applying continuous auction bids and matchup updates, then asserts responsiveness, screenshots, console output, and browser errors. |
| D.X.5 UI sweep | PASS | Browser full sweep visits auth, tabs, modals, player, auction-draft, and rookie-draft routes, with screenshots and console/error artifacts. |
| D.LONG.1/D.LONG.2 long-horizon pick trades | PARTIAL | Pick-chain mode creates a three-hop future-pick trade, verifies owner persistence every season, and checks the target rookie-draft slot belongs to the final owner when the pick year arrives. |
| D.LONG.3/D.LONG.4 standings/champion history | PARTIAL | History mode seeds deterministic completed-season standings/champion fixtures and verifies them after season resets. |
| D.LONG.5 mid-life migration | PENDING | Enable E2E_ENABLE_MIDLIFE_MIGRATION=1 to apply the no-op migration between seasons 5 and 6. |
| D.LONG.6 runtime drift | PENDING | Runtime metrics live in tests/artifacts/perf-metrics.json. |
| D.LONG.7 memory/connection leaks | PENDING | Harness memory metrics live in tests/artifacts/perf-metrics.json and 10+ season runs fail if RSS or heap exceeds the configured drift limit. |
| 10 seasons and continue past 10 / 20 clean | PENDING | Current run status is PARTIAL for target 1 season(s). |
| Production-ready exit criteria | FAIL | Coverage remains pending or failing for multiple required gameplay, long-horizon, and external-secret criteria. |

## Run Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: 70c70f7e-737d-402d-ad1c-3fd204faac5e (seed run 20260512045536)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- Browser smoke enabled through E2E_ENABLE_BROWSER=1 with full route sweep.
- Browser auth scenario enabled through E2E_ENABLE_BROWSER_AUTH=1.
- Browser perf smoke enabled through E2E_ENABLE_BROWSER_PERF=1.
- League create/join lifecycle scenario disabled; set E2E_ENABLE_LEAGUE_LIFECYCLE=1 to exercise D.SET.2 through real auth RPCs.
- Future-pick multi-hop scenario enabled through E2E_ENABLE_PICK_CHAIN=1.
- Push notification intercept enabled through E2E_ENABLE_PUSH=1.
- Draft push notification intercept enabled through E2E_ENABLE_DRAFT_PUSH=1.
- Standings/champion history retention enabled through E2E_ENABLE_HISTORY=1.
- Realtime latency check enabled through E2E_ENABLE_REALTIME=1 for 10 clients.
- Mid-life migration check disabled; set E2E_ENABLE_MIDLIFE_MIGRATION=1 to exercise D.LONG.5.
- Auction bid validation enabled through E2E_ENABLE_AUCTION=1.
- Playoff bracket scenario enabled through E2E_ENABLE_PLAYOFFS=1.
- Standings tiebreaker/RPS scenario enabled through E2E_ENABLE_TIEBREAKERS=1.
- Commissioner settings propagation scenario enabled through E2E_ENABLE_SETTINGS=1.
- Weekly starter-only scoring/finalization scenario enabled through E2E_ENABLE_SCORING=1.
- Sleeper injury-status filter scenario enabled through E2E_ENABLE_INJURY_FILTER=1.
- Trade acceptance atomicity scenario enabled through E2E_ENABLE_TRADE_ACCEPT=1.
- Rookie draft auto-pick/order scenario enabled through E2E_ENABLE_ROOKIE_DRAFT=1.
- Season reset carryover/reseed scenario enabled through E2E_ENABLE_SEASON_RESET=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Future-pick chain: 2060 round 1 pick cd15c606-ca7b-4196-88cc-bac5d662e233 now belongs to E2E Team 7.
- CORS preflight check passed for the configured frontend origin.
- Backend EXPO_PUSH_URL points at the fake upstream push intercept.
- Perf metrics written to tests/artifacts/perf-metrics.json.
