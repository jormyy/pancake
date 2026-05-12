# Multi-Season E2E Soak Report

- Status: ERROR
- Started: 2026-05-12T04:39:26.530Z
- Finished: 2026-05-12T04:39:39.019Z
- Target seasons: 1
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 0 | ERROR | D.X.2: realtime client 1 subscribe status TIMED_OUT |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: <remote configured>
- Configured frontend: http://127.0.0.1:8081
- Target league: fca79d8f-3cda-4fd8-adb9-83608b98a64a (seed run 20260512030735)
- Backend tick endpoints were not enabled; set E2E_ENABLE_BACKEND_TICKS=1 with a local backend to run them.
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.
- Future-pick multi-hop scenario disabled; set E2E_ENABLE_PICK_CHAIN=1 to exercise D.LONG.2.
- Push notification intercept disabled; set E2E_ENABLE_PUSH=1 with backend EXPO_PUSH_URL pointed at the fake upstream to exercise the trade-notification slice of D.X.1.
- Standings/champion history retention disabled; set E2E_ENABLE_HISTORY=1 with backend ticks to exercise the D.LONG.3/D.LONG.4 fixture-retention slice.
- Realtime latency check enabled through E2E_ENABLE_REALTIME=1 for 10 clients.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- The soak runner failed before completing the requested season loop.
