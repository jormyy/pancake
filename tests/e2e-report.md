# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T07:52:45.416Z
- Finished: 2026-05-12T07:59:28.715Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; draft push notification intercept passed; auction bid validation passed; playoff bracket scenario passed; standings tiebreaker scenario passed; commissioner settings propagation passed; weekly scoring finalization passed; injury status filter passed; trade acceptance atomicity passed; rookie draft auto-pick passed; season reset carryover passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained |
| 2 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 3 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 4 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 5 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; rookie draft traded-pick slot resolved; standings/champion history retained; snapshot row-count diff passed |
| 6 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; mid-life migration applied (UP_TO_DATE); matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 7 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 8 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 9 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed |
| 10 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; realtime matchup update delivered; trade and waiver push notification intercepts passed; matchup generation idempotency passed; multi-hop future-pick owner resolved; standings/champion history retained; snapshot row-count diff passed; runtime drift check passed; harness memory drift check passed |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: 70c70f7e-737d-402d-ad1c-3fd204faac5e (seed run 20260512045536)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.
- League create/join lifecycle scenario disabled; set E2E_ENABLE_LEAGUE_LIFECYCLE=1 to exercise D.SET.2 through real auth RPCs.
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
- Sleeper injury-status filter scenario enabled through E2E_ENABLE_INJURY_FILTER=1.
- Trade acceptance atomicity scenario enabled through E2E_ENABLE_TRADE_ACCEPT=1.
- Rookie draft auto-pick/order scenario enabled through E2E_ENABLE_ROOKIE_DRAFT=1.
- Season reset carryover/reseed scenario enabled through E2E_ENABLE_SEASON_RESET=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Future-pick chain: 2050 round 1 pick 7feab10e-35c1-4fea-b2c7-c9cdb51193dd now belongs to E2E Team 6.
- CORS preflight check passed for the configured frontend origin.
- Backend EXPO_PUSH_URL points at the fake upstream push intercept.
- D.LONG.5 mid-life migration up_to_date before season 6.
- Perf metrics written to tests/artifacts/perf-metrics.json.
