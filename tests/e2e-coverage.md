# E2E Coverage Checklist

- Run status: PARTIAL
- Started: 2026-05-12T05:01:19.585Z
- Finished: 2026-05-12T05:01:28.178Z
- Target seasons: 6

## Prompt-To-Artifact Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| Phase A audit report | PASS | tests/audit-report.md exists. |
| P0/P1 findings resolved | PARTIAL | Post-refactor deltas are documented, but approval-blocked soak findings remain open and external service-role rotation/history purge is still outside the repo. |
| Real test Supabase project | PASS | Supabase URL/service-role credentials loaded from E2E/app env. |
| Fake NBA CDN/Sleeper upstream | PASS | Fake upstream configured for http://127.0.0.1:4555. |
| D.SET.1 auth/session/sign-out | PENDING | Enable E2E_ENABLE_BROWSER_AUTH=1 or use prior browser-auth artifact. |
| D.SET.2 league create/join/pick bank | PARTIAL | Seeded target league 70c70f7e-737d-402d-ad1c-3fd204faac5e; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md. |
| D.SET.4 initial auction draft | PENDING | No browser-driven auction draft scenario implemented. |
| D.0 invariant boundary checks | PASS | Season rows in tests/e2e-report.md include D.0 boundary checks or failure. |
| D.SEA.1 matchup generation idempotency | PENDING | Requires E2E_ENABLE_BACKEND_TICKS=1. |
| D.SEA.2 weekly lineup/scoring/waiver/trade loop | PENDING | Full weekly browser gameplay loop is not implemented. |
| D.SEA.3 standings tiebreakers/RPS | PENDING | No forced four-way tie or RPS browser/backend scenario implemented. |
| D.SEA.4 playoffs/champion | PENDING | No playoff bracket/champion scenario implemented. |
| D.SEA.5 rookie draft/traded picks | PENDING | Enable E2E_ENABLE_PICK_CHAIN=1. |
| D.SEA.6 season reset | PENDING | Requires E2E_ENABLE_BACKEND_TICKS=1. |
| D.SEA.7 snapshots/no shrink | PASS | Snapshot summaries are written under tests/snapshots/season-<N>/summary.json. |
| D.X.1 push notifications | PENDING | Trade push prior slice exists; draft push pending; enable E2E_ENABLE_PUSH=1. |
| D.X.2 realtime bid/score events | PENDING | Enable E2E_ENABLE_REALTIME=1. |
| D.X.3 CORS regression | PENDING | Requires backend tick mode. |
| D.X.4 perf smoke under draft/live scoring load | PENDING | No continuous-bid/live-scoring browser perf scenario implemented. |
| D.X.5 UI sweep | PENDING | Enable browser smoke/auth; full app route sweep pending. |
| D.LONG.1/D.LONG.2 long-horizon pick trades | PENDING | Multi-hop owner persistence exists; rookie-draft materialization currently fails pending approval to fix. |
| D.LONG.3/D.LONG.4 standings/champion history | PENDING | Enable E2E_ENABLE_HISTORY=1 with backend tick mode. |
| D.LONG.5 mid-life migration | PASS | Mid-life migration mode runs `npx supabase db push --linked --yes` between seasons and records tests/artifacts/season-<N>/midlife-migration.json. |
| D.LONG.6 runtime drift | PENDING | Runtime metrics live in tests/artifacts/perf-metrics.json. |
| D.LONG.7 memory/connection leaks | PENDING | Harness memory metrics live in tests/artifacts/perf-metrics.json; current invariant run exceeds default memory drift gate. |
| 10 seasons and continue past 10 / 20 clean | PENDING | Current run status is PARTIAL for target 6 season(s). |
| Production-ready exit criteria | FAIL | Coverage remains pending or failing for multiple required gameplay, long-horizon, and external-secret criteria. |

## Run Notes

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
- Mid-life migration check enabled after season 5.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- D.LONG.5 mid-life migration applied before season 6.
- Perf metrics written to tests/artifacts/perf-metrics.json.
