# Multi-Season E2E Soak Report

- Status: PASS
- Started: 2026-05-13T12:57:20.852Z
- Finished: 2026-05-13T12:57:38.823Z
- Target seasons: 1
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed; enabled scenario slices passed; browser league lifecycle passed; league lifecycle passed |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: <remote configured>
- Configured frontend: http://127.0.0.1:8081
- Target league: 1e0af770-0c11-432c-8b59-babdee6a6bb8 (seed run realtime053053)
- Backend tick endpoints were not enabled; set E2E_ENABLE_BACKEND_TICKS=1 with a local backend to run them.
- One-time scenario slices run in season 1 only; set E2E_REPEAT_SCENARIOS_EVERY_SEASON=1 to repeat them every simulated season.
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
- Browser league create/join lifecycle scenario enabled through E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE=1.
- League create/join lifecycle scenario enabled through E2E_ENABLE_LEAGUE_LIFECYCLE=1.
- Future-pick multi-hop scenario disabled; set E2E_ENABLE_PICK_CHAIN=1 to exercise D.LONG.2.
- Push notification intercept disabled; set E2E_ENABLE_PUSH=1 with backend EXPO_PUSH_URL pointed at the fake upstream to exercise the trade-notification slice of D.X.1.
- Draft push notification intercept disabled; set E2E_ENABLE_DRAFT_PUSH=1 to exercise the rookie auto-pick notification slice of D.X.1.
- Standings/champion history retention disabled; set E2E_ENABLE_HISTORY=1 with backend ticks to exercise the D.LONG.3/D.LONG.4 fixture-retention slice.
- Realtime latency check disabled; set E2E_ENABLE_REALTIME=1 to exercise the D.X.2 matchup and auction bid update slice.
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
- Perf metrics written to tests/artifacts/perf-metrics.json.
