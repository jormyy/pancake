# Multi-Season E2E Soak Report

- Status: FAIL
- Started: 2026-05-12T04:16:31.268Z
- Finished: 2026-05-12T04:16:41.265Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending |
| 2 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 3 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 4 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 5 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 6 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 7 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 8 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 9 | PASS | D.0 invariant boundary checks passed; full scenario/browser loop pending; snapshot row-count diff passed |
| 10 | FAIL | D.LONG.7: harness RSS memory drifted 23% from season 1 (105.6 MiB) to season 10 (129.8 MiB); limit is 20%; D.LONG.7: harness heap memory drifted 75% from season 1 (10.2 MiB) to season 10 (17.9 MiB); limit is 20% |

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
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Perf metrics written to tests/artifacts/perf-metrics.json.
