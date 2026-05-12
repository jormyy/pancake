# Multi-Season E2E Soak Report

- Status: PARTIAL
- Last completed 10-season run: 2026-05-12T15:41:06.473Z to 2026-05-12T15:47:01.455Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed before and after real season reset; waiver priority processing, league lifecycle, realtime, trade/waiver/draft push, auction validation, playoffs, tiebreakers, settings, scoring, injury filter, trade acceptance/veto, rookie draft, season reset, matchup idempotency, and multi-hop pick ownership passed. |
| 2 | PASS | D.0 invariant boundary checks passed before and after real season reset; realtime, trade/waiver push, matchup idempotency, multi-hop pick ownership, and snapshot row-count diff passed. |
| 3 | PASS | D.0 invariant boundary checks passed before and after real season reset; realtime, trade/waiver push, matchup idempotency, multi-hop pick ownership, and snapshot row-count diff passed. |
| 4 | PASS | D.0 invariant boundary checks passed before and after real season reset; realtime, trade/waiver push, matchup idempotency, multi-hop pick ownership, and snapshot row-count diff passed. |
| 5 | PASS | D.0 invariant boundary checks passed before and after real season reset; the traded rookie-draft pick slot resolved to the final multi-hop owner. |
| 6 | PASS | D.0 invariant boundary checks passed before and after real season reset; mid-life migration returned UP_TO_DATE before the season and all enabled checks passed. |
| 7 | PASS | D.0 invariant boundary checks passed before and after real season reset; realtime, trade/waiver push, matchup idempotency, multi-hop pick ownership, and snapshot row-count diff passed. |
| 8 | PASS | D.0 invariant boundary checks passed before and after real season reset; realtime, trade/waiver push, matchup idempotency, multi-hop pick ownership, and snapshot row-count diff passed. |
| 9 | PASS | D.0 invariant boundary checks passed before and after real season reset; realtime, trade/waiver push, matchup idempotency, multi-hop pick ownership, and snapshot row-count diff passed. |
| 10 | PASS | D.0 invariant boundary checks passed before and after real season reset; runtime drift and harness memory drift gates passed. |

## Follow-Up Runs

- A later history-only rerun on 2026-05-12 reached a hosted Supabase outage: Cloudflare 522/origin timeouts and connection-pool acquisition timeouts caused `/e2e/live-poll` to return 500 before the requested loop could complete. This was recorded as infrastructure failure, not an app invariant failure.
- Earlier targeted history verification passed for two real backend season resets with retained standings and champion rows; artifacts: `tests/artifacts/season-1/history-retention.json` and `tests/artifacts/season-2/history-retention.json`.

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
- Configured frontend: http://127.0.0.1:8081
- Target league: 70c70f7e-737d-402d-ad1c-3fd204faac5e (seed run 20260512045536)
- Browser-driving scenarios have passing targeted artifacts but are not part of the 10-season backend report, so the overall status remains PARTIAL rather than dynasty-stable.
- The soak runner now supports `E2E_REPEAT_SCENARIOS_EVERY_SEASON=1` / `--repeat-scenarios-every-season=true` to repeat opt-in browser/API scenario slices every simulated season instead of only season 1.
