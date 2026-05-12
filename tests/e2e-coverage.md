# E2E Coverage Checklist

- Run status: ERROR
- Started: 2026-05-12T04:33:23.562Z
- Finished: 2026-05-12T04:33:26.616Z
- Target seasons: 2

## Prompt-To-Artifact Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| Phase A audit report | PASS | tests/audit-report.md exists. |
| P0/P1 findings resolved | PARTIAL | Post-refactor deltas are documented, but approval-blocked soak findings remain open and external service-role rotation/history purge is still outside the repo. |
| Real test Supabase project | PASS | Supabase URL/service-role credentials loaded from E2E/app env. |
| Fake NBA CDN/Sleeper upstream | PASS | Fake upstream configured for http://127.0.0.1:4555. |
| D.SET.1 auth/session/sign-out | PENDING | Enable E2E_ENABLE_BROWSER_AUTH=1 or use prior browser-auth artifact. |
| D.SET.2 league create/join/pick bank | PARTIAL | Seeded target league fca79d8f-3cda-4fd8-adb9-83608b98a64a; invite/5y pick-bank proof lives in tests/e2e-seed-report.md. |
| D.SET.4 initial auction draft | PENDING | No browser-driven auction draft scenario implemented. |
| D.0 invariant boundary checks | PARTIAL | Season rows in tests/e2e-report.md include D.0 boundary checks or failure. |
| D.SEA.1 matchup generation idempotency | PENDING | Backend tick mode can call /e2e/generate-matchups twice and compare counts. |
| D.SEA.2 weekly lineup/scoring/waiver/trade loop | PENDING | Full weekly browser gameplay loop is not implemented. |
| D.SEA.3 standings tiebreakers/RPS | PENDING | No forced four-way tie or RPS browser/backend scenario implemented. |
| D.SEA.4 playoffs/champion | PENDING | No playoff bracket/champion scenario implemented. |
| D.SEA.5 rookie draft/traded picks | PENDING | Enable E2E_ENABLE_PICK_CHAIN=1. |
| D.SEA.6 season reset | PARTIAL | Backend tick mode calls /e2e/advance-season and re-checks invariants. |
| D.SEA.7 snapshots/no shrink | PENDING | Snapshot summaries are written under tests/snapshots/season-<N>/summary.json. |
| D.X.1 push notifications | PENDING | Trade push prior slice exists; draft push pending; enable E2E_ENABLE_PUSH=1. |
| D.X.2 realtime bid/score events | PENDING | No 10-client realtime latency assertion implemented. |
| D.X.3 CORS regression | PASS | Backend tick mode runs OPTIONS preflight before the season loop. |
| D.X.4 perf smoke under draft/live scoring load | PENDING | No continuous-bid/live-scoring browser perf scenario implemented. |
| D.X.5 UI sweep | PENDING | Enable browser smoke/auth; full app route sweep pending. |
| D.LONG.1/D.LONG.2 long-horizon pick trades | PENDING | Multi-hop owner persistence exists; rookie-draft materialization currently fails pending approval to fix. |
| D.LONG.3/D.LONG.4 standings/champion history | PENDING | History mode seeds deterministic completed-season standings/champion fixtures and verifies them after season resets. |
| D.LONG.5 mid-life migration | PENDING | No mid-soak migration application gate implemented. |
| D.LONG.6 runtime drift | PENDING | Runtime metrics live in tests/artifacts/perf-metrics.json. |
| D.LONG.7 memory/connection leaks | PENDING | Harness memory metrics live in tests/artifacts/perf-metrics.json; current invariant run exceeds default memory drift gate. |
| 10 seasons and continue past 10 / 20 clean | PENDING | Current run status is ERROR for target 2 season(s). |
| Production-ready exit criteria | FAIL | Coverage remains pending or failing for multiple required gameplay, long-horizon, and external-secret criteria. |

## Run Notes

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
