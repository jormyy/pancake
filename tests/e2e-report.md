# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T02:54:40.885Z
- Finished: 2026-05-12T02:59:07.061Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 2 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 3 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 4 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 5 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 6 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 7 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 8 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 9 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |
| 10 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; browser smoke passed |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: 97867cc1-e007-4b5b-b932-031c66d7651a (seed run 20260512024516)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- Browser smoke enabled through E2E_ENABLE_BROWSER=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
