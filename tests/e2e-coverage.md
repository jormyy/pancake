# E2E Coverage Checklist

- Run status: PASS
- Started: 2026-05-13T09:59:24.123Z
- Finished: 2026-05-13T12:08:37.867Z
- Target seasons: 20

## Prompt-To-Artifact Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| Phase A audit report | PASS | tests/audit-report.md exists. |
| P0/P1 findings resolved | PARTIAL | P0/P1 source fixes are documented; service-role JWT literals were purged from reachable local Git history, and Edge Functions now prefer Supabase secret keys from the platform-provided SUPABASE_SECRET_KEYS dictionary before legacy service-role fallback. GitHub branch rewrite is still blocked by repository push permissions. |
| Real test Supabase project | PASS | Supabase URL/admin credentials loaded from E2E/app env. |
| Fake NBA CDN/Sleeper upstream | PASS | Fake upstream configured for http://127.0.0.1:4555. |
| D.SET.1 auth/session/sign-out | PASS | Browser auth scenario was enabled for this run. |
| D.SET.2 league create/join/pick bank | PARTIAL | League-lifecycle mode signs in seeded users, calls create_league and join_league_by_invite_code through anon Supabase clients, then verifies invite code, members, lineup slots, current season, and five-year pick bank. |
| D.SET.3 commissioner settings propagation | PARTIAL | Settings mode creates a disposable league, updates league/scoring/slot settings as the commissioner through Supabase RLS, verifies a manager can read them, and checks manager writes do not mutate commissioner-only settings. |
| D.SET.4 initial auction draft | PARTIAL | Browser gameplay mode creates an isolated two-user league, opens the real auction draft room as the bidder, clicks the visible Bid button, and verifies nomination/bid rows changed. |
| D.0 invariant boundary checks | PASS | Season rows in tests/e2e-report.md include D.0 boundary checks or failure. |
| D.SEA.1 matchup generation idempotency | PASS | Backend tick mode can call /e2e/generate-matchups twice and compare counts. |
| D.SEA.2 weekly lineup/scoring/waiver/trade loop | PARTIAL | Browser lineup mode creates an isolated league, opens the real lineup modal, moves a bench PG into an empty PG starter slot, and verifies the weekly_lineups row persisted. |
| D.SEA.2 injury status filtering | PARTIAL | Injury-filter mode mutates the fake Sleeper upstream, runs the real backend /e2e/sync-players path, and verifies junk injury_status values such as Scrambled are filtered while valid statuses persist. |
| D.SEA.2 multi-asset trade acceptance | PARTIAL | Trade-accept mode creates a disposable player+future-pick trade, verifies mismatched auth/member acceptance is rejected, accepts through the real /trades/:tradeId/accept route, checks assets stay put during the veto window, expires the window, runs /e2e/process-trades, and checks players, picks, trade status, and transaction rows. |
| D.SEA.3 standings tiebreakers/RPS | PARTIAL | Tiebreaker mode seeds a disposable four-way tie and calls the real authenticated /playoffs/generate route to verify max-points/points-against/RPS handling. |
| D.SEA.4 playoffs/champion | PARTIAL | Browser playoff mode creates a disposable 10-team league, generates the real top-six bracket, verifies advance blocking, finalizes playoff rounds, crowns a champion, then opens the real bracket modal and checks the champion banner. |
| D.SEA.5 rookie draft/traded picks | PARTIAL | Browser rookie-draft mode creates an isolated offseason league, opens the real rookie draft room as the first pick owner, lets the 30s timer expire, and verifies the browser-triggered auto-pick, roster insert, and linked pick asset usage. |
| D.SEA.6 season reset | PARTIAL | Season-reset mode creates a disposable league, calls the real /e2e/advance-season endpoint, and verifies current-season flip, roster carryover, waiver reseed, prior-season queryability, and rolling five-year pick horizon. |
| D.SEA.7 snapshots/no shrink | PASS | Snapshot summaries are written under tests/snapshots/season-<N>/summary.json. |
| D.X.1 push notifications | PARTIAL | Push mode verifies trade and waiver notifications through the fake Expo upstream; draft-push mode separately verifies rookie auto-pick notifications when enabled. |
| D.X.2 realtime bid/score events | PARTIAL | The 20-season proof asserted matchup score realtime to 10 clients; the follow-up local focused run also asserted auction bid nomination realtime to 10 clients. A full 20-season rerun with `20260513000001_enable_draft_realtime.sql` pushed remotely is still pending. |
| D.X.3 CORS regression | PASS | Backend tick mode runs OPTIONS preflight before the season loop. |
| D.X.4 perf smoke under draft/live scoring load | PASS | Browser perf mode opens the real draft room and home scoreboard while applying continuous auction bids and matchup updates, then asserts responsiveness, screenshots, console output, and browser errors. |
| D.X.5 UI sweep | PASS | Browser full sweep visits auth, tabs, modals, player, auction-draft, and rookie-draft routes, with screenshots and console/error artifacts. |
| D.LONG.1/D.LONG.2 long-horizon pick trades | PARTIAL | Pick-chain mode creates a three-hop future-pick trade, verifies owner persistence every season, and checks the target rookie-draft slot belongs to the final owner when the pick year arrives. |
| D.LONG.3/D.LONG.4 standings/champion history | PARTIAL | History mode seeds deterministic completed-season standings/champion fixtures and verifies them after season resets. |
| D.LONG.5 mid-life migration | PASS | Mid-life migration mode runs `npx supabase db push` against the configured local/linked/db-url target between seasons and records tests/artifacts/season-<N>/midlife-migration.json. |
| D.LONG.6 runtime drift | PASS | Runtime metrics live in tests/artifacts/perf-metrics.json. |
| D.LONG.7 memory/connection leaks | PASS | Harness memory metrics live in tests/artifacts/perf-metrics.json and 10+ season runs fail if RSS or heap exceeds the configured drift limit. |
| 10 seasons and continue past 10 / 20 clean | PASS | Current run status is PASS for target 20 season(s); PARTIAL means enabled season rows passed but full gameplay coverage is still pending. |
| Production-ready exit criteria | FAIL | Coverage remains pending or failing for multiple required gameplay and long-horizon criteria. |

## Run Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: fffefbf8-ffa5-4cd2-8bc8-fc4048a97cd1 (seed run 20260512171914)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- One-time scenario slices repeat every simulated season through E2E_REPEAT_SCENARIOS_EVERY_SEASON=1.
- Browser smoke enabled through E2E_ENABLE_BROWSER=1 with full route sweep.
- Browser auth scenario enabled through E2E_ENABLE_BROWSER_AUTH=1.
- Browser perf smoke enabled through E2E_ENABLE_BROWSER_PERF=1.
- Browser gameplay scenario enabled through E2E_ENABLE_BROWSER_GAMEPLAY=1.
- Browser lineup scenario enabled through E2E_ENABLE_BROWSER_LINEUP=1.
- Browser lineup auto-set scenario enabled through E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1.
- Browser lineup locked-player scenario enabled through E2E_ENABLE_BROWSER_LINEUP_LOCKED=1.
- Browser playoff champion scenario enabled through E2E_ENABLE_BROWSER_PLAYOFF=1.
- Browser rookie draft auto-pick scenario enabled through E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1.
- Browser waiver scenario enabled through E2E_ENABLE_BROWSER_WAIVER=1.
- Browser waiver drop scenario enabled through E2E_ENABLE_BROWSER_WAIVER_DROP=1.
- Browser waiver IR-block scenario enabled through E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1.
- Browser trade proposal scenario enabled through E2E_ENABLE_BROWSER_TRADE=1.
- Browser trade accept scenario enabled through E2E_ENABLE_BROWSER_TRADE_ACCEPT=1.
- Browser trade reject/withdraw scenario enabled through E2E_ENABLE_BROWSER_TRADE_TERMINAL=1.
- Browser future-pick trade scenario enabled through E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1.
- Browser future-pick trade accept scenario enabled through E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1.
- Browser trade overflow accept scenario enabled through E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1.
- Browser post-deadline trade scenario enabled through E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1.
- Browser trade veto scenario enabled through E2E_ENABLE_BROWSER_TRADE_VETO=1.
- League create/join lifecycle scenario enabled through E2E_ENABLE_LEAGUE_LIFECYCLE=1.
- Future-pick multi-hop scenario enabled through E2E_ENABLE_PICK_CHAIN=1.
- Push notification intercept enabled through E2E_ENABLE_PUSH=1.
- Draft push notification intercept enabled through E2E_ENABLE_DRAFT_PUSH=1.
- Standings/champion history retention enabled through E2E_ENABLE_HISTORY=1.
- Realtime latency check enabled through E2E_ENABLE_REALTIME=1 for 10 clients.
- Mid-life migration check enabled after season 5.
- Auction bid validation enabled through E2E_ENABLE_AUCTION=1.
- Playoff bracket scenario enabled through E2E_ENABLE_PLAYOFFS=1.
- Standings tiebreaker/RPS scenario enabled through E2E_ENABLE_TIEBREAKERS=1.
- Commissioner settings propagation scenario enabled through E2E_ENABLE_SETTINGS=1.
- Weekly starter-only scoring/finalization scenario enabled through E2E_ENABLE_SCORING=1.
- Waiver priority/daily processing scenario enabled through E2E_ENABLE_WAIVER_PROCESSING=1.
- Trade veto threshold scenario enabled through E2E_ENABLE_TRADE_VETO=1.
- Sleeper injury-status filter scenario enabled through E2E_ENABLE_INJURY_FILTER=1.
- Trade acceptance atomicity scenario enabled through E2E_ENABLE_TRADE_ACCEPT=1.
- Rookie draft auto-pick/order scenario enabled through E2E_ENABLE_ROOKIE_DRAFT=1.
- Season reset carryover/reseed scenario enabled through E2E_ENABLE_SEASON_RESET=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Future-pick chain: 2157 round 1 pick 12ae3a8d-379f-4471-94fb-0c08358f3218 now belongs to E2E Team 4.
- CORS preflight check passed for the configured frontend origin.
- Backend EXPO_PUSH_URL points at the fake upstream push intercept.
- D.LONG.5 mid-life migration up_to_date before season 6.
- Perf metrics written to tests/artifacts/perf-metrics.json.
