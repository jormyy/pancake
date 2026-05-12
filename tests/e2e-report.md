# Multi-Season E2E Soak Report

- Status: ERROR
- Started: 2026-05-12T04:33:23.562Z
- Finished: 2026-05-12T04:33:26.616Z
- Target seasons: 2
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 0 | ERROR | /e2e/process-waivers returned 500 |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: fca79d8f-3cda-4fd8-adb9-83608b98a64a (seed run 20260512030735)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.
- Future-pick multi-hop scenario disabled; set E2E_ENABLE_PICK_CHAIN=1 to exercise D.LONG.2.
- Push notification intercept disabled; set E2E_ENABLE_PUSH=1 with backend EXPO_PUSH_URL pointed at the fake upstream to exercise the trade-notification slice of D.X.1.
- Standings/champion history retention enabled through E2E_ENABLE_HISTORY=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- CORS preflight check passed for the configured frontend origin.
- The soak runner failed before completing the requested season loop.
