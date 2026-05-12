# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T05:30:49.875Z
- Finished: 2026-05-12T05:30:55.401Z
- Target seasons: 1
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; commissioner settings propagation passed |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: <remote configured>
- Configured frontend: http://127.0.0.1:8081
- Target league: 70c70f7e-737d-402d-ad1c-3fd204faac5e (seed run 20260512045536)
- Backend tick endpoints were not enabled; set E2E_ENABLE_BACKEND_TICKS=1 with a local backend to run them.
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.
- Future-pick multi-hop scenario disabled; set E2E_ENABLE_PICK_CHAIN=1 to exercise D.LONG.2.
- Push notification intercept disabled; set E2E_ENABLE_PUSH=1 with backend EXPO_PUSH_URL pointed at the fake upstream to exercise the trade-notification slice of D.X.1.
- Standings/champion history retention disabled; set E2E_ENABLE_HISTORY=1 with backend ticks to exercise the D.LONG.3/D.LONG.4 fixture-retention slice.
- Realtime latency check disabled; set E2E_ENABLE_REALTIME=1 to exercise the D.X.2 matchups update slice.
- Mid-life migration check disabled; set E2E_ENABLE_MIDLIFE_MIGRATION=1 to exercise D.LONG.5.
- Auction validation disabled; set E2E_ENABLE_AUCTION=1 to exercise the D.SET.4 server-side bid validation slice.
- Playoff bracket scenario disabled; set E2E_ENABLE_PLAYOFFS=1 to exercise the D.SEA.4 top-6 bracket slice.
- Standings tiebreaker/RPS scenario disabled; set E2E_ENABLE_TIEBREAKERS=1 to exercise D.SEA.3.
- Commissioner settings propagation scenario enabled through E2E_ENABLE_SETTINGS=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Perf metrics written to tests/artifacts/perf-metrics.json.
