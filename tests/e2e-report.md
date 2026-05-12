# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T08:30:36.939Z
- Finished: 2026-05-12T08:34:32.742Z
- Target seasons: 1
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed; browser auth scenario passed; browser perf smoke passed; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained |

## Notes

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
