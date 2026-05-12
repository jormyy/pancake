# E2E Coverage Checklist

- Run status: PARTIAL
- Started: 2026-05-12T14:50:26.482Z
- Finished: 2026-05-12T14:52:53.545Z
- Target seasons: 20

## Prompt-To-Artifact Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| Phase A audit report | PASS | tests/audit-report.md exists. |
| P0/P1 findings resolved | PARTIAL | Post-refactor deltas and soak fixes are documented; operational secret rotation/history purge remains outside repo source control. |
| Real test Supabase project | PASS | Supabase URL/service-role credentials loaded from E2E/app env. |
| Fake NBA CDN/Sleeper upstream | PASS | Fake upstream configured for http://127.0.0.1:4555. |
| D.SET.1 auth/session/sign-out | PENDING | Enable E2E_ENABLE_BROWSER_AUTH=1 or use prior browser-auth artifact. |
| D.SET.2 league create/join/pick bank | PARTIAL | Seeded target league 70c70f7e-737d-402d-ad1c-3fd204faac5e; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md. |
| D.SET.3 commissioner settings propagation | PENDING | No commissioner settings propagation scenario implemented; enable E2E_ENABLE_SETTINGS=1. |
| D.SET.4 initial auction draft | PENDING | Enable E2E_ENABLE_BROWSER_GAMEPLAY=1 for browser auction gameplay or E2E_ENABLE_AUCTION=1 for server-side bid validation. |
| D.0 invariant boundary checks | PASS | Season rows in tests/e2e-report.md include D.0 boundary checks or failure. |
| D.SEA.1 matchup generation idempotency | PASS | Backend tick mode can call /e2e/generate-matchups twice and compare counts. |
| D.SEA.2 weekly lineup/scoring/waiver/trade loop | PENDING | Full weekly browser gameplay loop is not implemented; enable E2E_ENABLE_BROWSER_LINEUP=1 for manual lineup setting, E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1 for auto-set lineup setting, E2E_ENABLE_BROWSER_LINEUP_LOCKED=1 for locked-player move blocking, E2E_ENABLE_BROWSER_WAIVER=1 for no-drop waiver claim UI coverage, E2E_ENABLE_BROWSER_WAIVER_DROP=1 for drop-then-add waiver claim UI coverage, E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1 for DTD-on-IR claim blocking, E2E_ENABLE_WAIVER_PROCESSING=1 for priority/drop/failure daily processing, E2E_ENABLE_BROWSER_TRADE=1 for player proposal UI coverage, E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1 for future-pick proposal UI coverage, E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1 for future-pick accept UI coverage, E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1 for drop-before-accept UI coverage, E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1 for post-deadline proposal rejection, E2E_ENABLE_BROWSER_TRADE_VETO=1 for accepted-state veto UI coverage, E2E_ENABLE_BROWSER_TRADE_ACCEPT=1 for accept UI coverage, E2E_ENABLE_BROWSER_TRADE_TERMINAL=1 for reject/withdraw UI coverage, E2E_ENABLE_TRADE_VETO=1 for trade veto threshold coverage, or E2E_ENABLE_SCORING=1 for the starter-only scoring/finalization slice. |
| D.SEA.2 injury status filtering | PENDING | Enable E2E_ENABLE_INJURY_FILTER=1 to inject fake Sleeper injuries and verify Scrambled is filtered. |
| D.SEA.2 multi-asset trade acceptance | PENDING | Enable E2E_ENABLE_TRADE_ACCEPT=1 to exercise authenticated multi-asset trade acceptance. |
| D.SEA.3 standings tiebreakers/RPS | PENDING | No forced four-way tie or RPS browser/backend scenario implemented; enable E2E_ENABLE_TIEBREAKERS=1 for standings tiebreaker coverage. |
| D.SEA.4 playoffs/champion | PENDING | Enable E2E_ENABLE_BROWSER_PLAYOFF=1 for browser champion coverage or E2E_ENABLE_PLAYOFFS=1 for backend bracket-generation coverage. |
| D.SEA.5 rookie draft/traded picks | PARTIAL | Pick-chain mode verifies multi-hop future-pick ownership every season and materializes the traded pick in the target rookie draft year. |
| D.SEA.6 season reset | PARTIAL | Backend tick mode calls /e2e/advance-season and re-checks invariants. |
| D.SEA.7 snapshots/no shrink | PASS | Snapshot summaries are written under tests/snapshots/season-<N>/summary.json. |
| D.X.1 push notifications | PENDING | Trade push prior slice exists; waiver and draft push slices are separate; enable E2E_ENABLE_PUSH=1 or E2E_ENABLE_DRAFT_PUSH=1. |
| D.X.2 realtime bid/score events | PENDING | Enable E2E_ENABLE_REALTIME=1. |
| D.X.3 CORS regression | PASS | Backend tick mode runs OPTIONS preflight before the season loop. |
| D.X.4 perf smoke under draft/live scoring load | PENDING | Enable E2E_ENABLE_BROWSER_PERF=1 to run the continuous-bid/live-scoring browser perf smoke. |
| D.X.5 UI sweep | PENDING | Enable browser smoke/auth; full app route sweep pending. |
| D.LONG.1/D.LONG.2 long-horizon pick trades | PARTIAL | Pick-chain mode creates a three-hop future-pick trade, verifies owner persistence every season, and checks the target rookie-draft slot belongs to the final owner when the pick year arrives. |
| D.LONG.3/D.LONG.4 standings/champion history | PENDING | Enable E2E_ENABLE_HISTORY=1 with backend tick mode. |
| D.LONG.5 mid-life migration | PENDING | Enable E2E_ENABLE_MIDLIFE_MIGRATION=1 to apply the no-op migration between seasons 5 and 6. |
| D.LONG.6 runtime drift | PASS | Runtime metrics live in tests/artifacts/perf-metrics.json. |
| D.LONG.7 memory/connection leaks | PASS | Harness memory metrics live in tests/artifacts/perf-metrics.json and 10+ season runs fail if RSS or heap exceeds the configured drift limit. |
| 10 seasons and continue past 10 / 20 clean | PARTIAL | Current run status is PARTIAL for target 20 season(s); enabled season rows passed but full gameplay coverage is still pending. |
| Production-ready exit criteria | FAIL | Coverage remains pending or failing for multiple required gameplay and long-horizon criteria. |

## Run Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: 70c70f7e-737d-402d-ad1c-3fd204faac5e (seed run 20260512045536)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.
- Browser perf smoke disabled; set E2E_ENABLE_BROWSER_PERF=1 to exercise D.X.4 under continuous auction and live-score mutations.
- Browser gameplay scenario disabled; set E2E_ENABLE_BROWSER_GAMEPLAY=1 to exercise the D.SET.4 auction bid UI slice.
- Browser lineup scenario disabled; set E2E_ENABLE_BROWSER_LINEUP=1 to exercise manual lineup setting.
- Browser lineup auto-set scenario disabled; set E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1 to exercise auto-set lineup setting.
- Browser lineup locked-player scenario disabled; set E2E_ENABLE_BROWSER_LINEUP_LOCKED=1 to exercise locked-player move blocking.
- Browser playoff champion scenario disabled; set E2E_ENABLE_BROWSER_PLAYOFF=1 to exercise the D.SEA.4 champion bracket UI slice.
- Browser rookie draft auto-pick scenario disabled; set E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1 to exercise the D.SEA.5 30-second timer slice.
- Browser waiver scenario disabled; set E2E_ENABLE_BROWSER_WAIVER=1 to exercise the D.SEA.2 waiver claim UI slice.
- Browser waiver drop scenario disabled; set E2E_ENABLE_BROWSER_WAIVER_DROP=1 to exercise the D.SEA.2 drop-then-add waiver claim UI slice.
- Browser waiver IR-block scenario disabled; set E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1 to exercise DTD-on-IR claim blocking.
- Browser trade proposal scenario disabled; set E2E_ENABLE_BROWSER_TRADE=1 to exercise the D.SEA.2 trade proposal UI slice.
- Browser trade accept scenario disabled; set E2E_ENABLE_BROWSER_TRADE_ACCEPT=1 to exercise the D.SEA.2 trade accept UI slice.
- Browser trade reject/withdraw scenario disabled; set E2E_ENABLE_BROWSER_TRADE_TERMINAL=1 to exercise the D.SEA.2 trade terminal-action UI slice.
- Browser future-pick trade scenario disabled; set E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1 to exercise the D.SEA.2 future-pick proposal UI slice.
- Browser future-pick trade accept scenario disabled; set E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1 to exercise the D.SEA.2 future-pick accept UI slice.
- Browser trade overflow accept scenario disabled; set E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1 to exercise the D.SEA.2 drop-before-accept UI slice.
- Browser post-deadline trade scenario disabled; set E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1 to exercise the D.SEA.2 trade-deadline rejection slice.
- Browser trade veto scenario disabled; set E2E_ENABLE_BROWSER_TRADE_VETO=1 to exercise the D.SEA.2 accepted-state veto UI slice.
- League create/join lifecycle scenario disabled; set E2E_ENABLE_LEAGUE_LIFECYCLE=1 to exercise D.SET.2 through real auth RPCs.
- Future-pick multi-hop scenario enabled through E2E_ENABLE_PICK_CHAIN=1.
- Push notification intercept disabled; set E2E_ENABLE_PUSH=1 with backend EXPO_PUSH_URL pointed at the fake upstream to exercise the trade-notification slice of D.X.1.
- Draft push notification intercept disabled; set E2E_ENABLE_DRAFT_PUSH=1 to exercise the rookie auto-pick notification slice of D.X.1.
- Standings/champion history retention disabled; set E2E_ENABLE_HISTORY=1 with backend ticks to exercise the D.LONG.3/D.LONG.4 fixture-retention slice.
- Realtime latency check disabled; set E2E_ENABLE_REALTIME=1 to exercise the D.X.2 matchups update slice.
- Mid-life migration check disabled; set E2E_ENABLE_MIDLIFE_MIGRATION=1 to exercise D.LONG.5.
- Auction validation disabled; set E2E_ENABLE_AUCTION=1 to exercise the D.SET.4 server-side bid validation slice.
- Playoff bracket scenario disabled; set E2E_ENABLE_PLAYOFFS=1 to exercise the D.SEA.4 top-6 bracket slice.
- Standings tiebreaker/RPS scenario disabled; set E2E_ENABLE_TIEBREAKERS=1 to exercise D.SEA.3.
- Commissioner settings propagation scenario disabled; set E2E_ENABLE_SETTINGS=1 to exercise D.SET.3.
- Weekly starter-only scoring/finalization scenario disabled; set E2E_ENABLE_SCORING=1 to exercise the D.SEA.2 scoring slice.
- Waiver priority/daily processing scenario disabled; set E2E_ENABLE_WAIVER_PROCESSING=1 to exercise priority, drop, failed_roster, and daily processing.
- Trade veto threshold scenario disabled; set E2E_ENABLE_TRADE_VETO=1 to exercise the D.SEA.2 veto-window slice.
- Sleeper injury-status filter scenario disabled; set E2E_ENABLE_INJURY_FILTER=1 to exercise the D.SEA.2 injury injection slice.
- Trade acceptance atomicity scenario disabled; set E2E_ENABLE_TRADE_ACCEPT=1 to exercise the D.SEA.2 multi-asset trade slice.
- Rookie draft auto-pick/order scenario disabled; set E2E_ENABLE_ROOKIE_DRAFT=1 to exercise the D.SEA.5 auto-pick slice.
- Season reset carryover/reseed scenario disabled; set E2E_ENABLE_SEASON_RESET=1 to exercise the D.SEA.6 reset slice.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Future-pick chain: 2116 round 1 pick ac460c51-d5cb-43a5-85f7-cb0bb5de597e now belongs to E2E Team 4.
- CORS preflight check passed for the configured frontend origin.
- Perf metrics written to tests/artifacts/perf-metrics.json.
