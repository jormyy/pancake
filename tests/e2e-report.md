# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T04:01:09.681Z
- Finished: 2026-05-12T04:02:40.590Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed |
| 2 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 3 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 4 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 5 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 6 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 7 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 8 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 9 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed |
| 10 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; trade push notification intercept passed; matchup generation idempotency passed; snapshot row-count diff passed; runtime drift check passed |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: fca79d8f-3cda-4fd8-adb9-83608b98a64a (seed run 20260512030735)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.
- Future-pick multi-hop scenario disabled; set E2E_ENABLE_PICK_CHAIN=1 to exercise D.LONG.2.
- Push notification intercept enabled through E2E_ENABLE_PUSH=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- CORS preflight check passed for the configured frontend origin.
- Backend EXPO_PUSH_URL points at the fake upstream push intercept.
- Perf metrics written to tests/artifacts/perf-metrics.json.
