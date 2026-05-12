# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T17:09:01.977Z
- Finished: 2026-05-12T17:09:59.366Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained |
| 2 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 3 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 4 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 5 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; rookie draft traded-pick slot resolved; standings/champion history retained; snapshot row-count diff passed |
| 6 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 7 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 8 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 9 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 10 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; waiver priority processing passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; trade veto threshold passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: 728ae18c-2cfa-4d60-8dbd-3bdbc151972c (seed run local20260512100826)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- One-time scenario slices repeat every simulated season through E2E_REPEAT_SCENARIOS_EVERY_SEASON=1.
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
- Waiver priority/daily processing scenario enabled through E2E_ENABLE_WAIVER_PROCESSING=1.
- Trade veto threshold scenario enabled through E2E_ENABLE_TRADE_VETO=1.
- Sleeper injury-status filter scenario enabled through E2E_ENABLE_INJURY_FILTER=1.
- Trade acceptance atomicity scenario enabled through E2E_ENABLE_TRADE_ACCEPT=1.
- Rookie draft auto-pick/order scenario enabled through E2E_ENABLE_ROOKIE_DRAFT=1.
- Season reset carryover/reseed scenario enabled through E2E_ENABLE_SEASON_RESET=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Future-pick chain: 2031 round 1 pick c2001767-4781-49a2-9637-153cba8f4dd0 now belongs to E2E Team 4.
- CORS preflight check passed for the configured frontend origin.
- Backend EXPO_PUSH_URL points at the fake upstream push intercept.
- Perf metrics written to tests/artifacts/perf-metrics.json.
