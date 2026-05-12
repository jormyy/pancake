# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T03:08:04.799Z
- Finished: 2026-05-12T03:09:06.782Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 2 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 3 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 4 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 5 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 6 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 7 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 8 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 9 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |
| 10 | PASS | D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending; multi-hop future-pick owner resolved |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: fca79d8f-3cda-4fd8-adb9-83608b98a64a (seed run 20260512030735)
- Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Future-pick multi-hop scenario enabled through E2E_ENABLE_PICK_CHAIN=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Future-pick chain: 2031 round 1 pick 582d899a-5a07-4399-a8ae-fc4880b06c2b now belongs to E2E Team 4.
