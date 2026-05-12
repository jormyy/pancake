# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T14:50:26.482Z
- Finished: 2026-05-12T14:52:53.545Z
- Target seasons: 20
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved |
| 2 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed |
| 3 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed |
| 4 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed |
| 5 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; rookie draft traded-pick slot resolved; snapshot row-count diff passed |
| 6 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed |
| 7 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed |
| 8 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed |
| 9 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed |
| 10 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 11 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 12 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 13 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 14 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 15 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 16 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 17 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 18 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 19 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |
| 20 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; matchup generation idempotency passed; multi-hop future-pick owner resolved; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |

## Notes

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
