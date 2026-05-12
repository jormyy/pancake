# E2E Coverage Checklist

- Run status: FAIL
- Started: 2026-05-12T05:39:02.473Z
- Finished: 2026-05-12T05:39:24.715Z
- Target seasons: 1

## Prompt-To-Artifact Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| Phase A audit report | PASS | tests/audit-report.md exists. |
| P0/P1 findings resolved | PARTIAL | Post-refactor deltas are documented, but approval-blocked soak findings remain open and external service-role rotation/history purge is still outside the repo. |
| Real test Supabase project | PASS | Supabase URL/service-role credentials loaded from E2E/app env. |
| Fake NBA CDN/Sleeper upstream | PASS | Fake upstream configured for http://127.0.0.1:4555. |
| D.SET.1 auth/session/sign-out | PENDING | Enable E2E_ENABLE_BROWSER_AUTH=1 or use prior browser-auth artifact. |
| D.SET.2 league create/join/pick bank | PARTIAL | Seeded target league 70c70f7e-737d-402d-ad1c-3fd204faac5e; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md. |
| D.SET.3 commissioner settings propagation | PENDING | No commissioner settings propagation scenario implemented; enable E2E_ENABLE_SETTINGS=1. |
| D.SET.4 initial auction draft | PENDING | No browser-driven auction draft scenario implemented; enable E2E_ENABLE_AUCTION=1 for server-side bid validation slice. |
| D.0 invariant boundary checks | PARTIAL | Season rows in tests/e2e-report.md include D.0 boundary checks or failure. |
| D.SEA.1 matchup generation idempotency | PENDING | Requires E2E_ENABLE_BACKEND_TICKS=1. |
| D.SEA.2 weekly lineup/scoring/waiver/trade loop | FAIL | Scoring mode seeds a disposable matchup with starter/bench lineups and real player_game_stats, calls the real backend /e2e/sync-scores path, and checks starter-only points, finalization blocking, winner, max-possible points, and standings append. |
| D.SEA.3 standings tiebreakers/RPS | PENDING | No forced four-way tie or RPS browser/backend scenario implemented; enable E2E_ENABLE_TIEBREAKERS=1 for standings tiebreaker coverage. |
| D.SEA.4 playoffs/champion | PENDING | No playoff bracket/champion scenario implemented; enable E2E_ENABLE_PLAYOFFS=1 for bracket-generation coverage. |
| D.SEA.5 rookie draft/traded picks | PENDING | Enable E2E_ENABLE_PICK_CHAIN=1. |
| D.SEA.6 season reset | PENDING | Requires E2E_ENABLE_BACKEND_TICKS=1. |
| D.SEA.7 snapshots/no shrink | PENDING | Snapshot summaries are written under tests/snapshots/season-<N>/summary.json. |
| D.X.1 push notifications | PENDING | Trade push prior slice exists; draft push pending; enable E2E_ENABLE_PUSH=1. |
| D.X.2 realtime bid/score events | PENDING | Enable E2E_ENABLE_REALTIME=1. |
| D.X.3 CORS regression | PENDING | Requires backend tick mode. |
| D.X.4 perf smoke under draft/live scoring load | PENDING | No continuous-bid/live-scoring browser perf scenario implemented. |
| D.X.5 UI sweep | PENDING | Enable browser smoke/auth; full app route sweep pending. |
| D.LONG.1/D.LONG.2 long-horizon pick trades | PENDING | Multi-hop owner persistence exists; rookie-draft materialization currently fails pending approval to fix. |
| D.LONG.3/D.LONG.4 standings/champion history | PENDING | Enable E2E_ENABLE_HISTORY=1 with backend tick mode. |
| D.LONG.5 mid-life migration | PENDING | Enable E2E_ENABLE_MIDLIFE_MIGRATION=1 to apply the no-op migration between seasons 5 and 6. |
| D.LONG.6 runtime drift | PENDING | Runtime metrics live in tests/artifacts/perf-metrics.json. |
| D.LONG.7 memory/connection leaks | PENDING | Harness memory metrics live in tests/artifacts/perf-metrics.json; current invariant run exceeds default memory drift gate. |
| 10 seasons and continue past 10 / 20 clean | PENDING | Current run status is FAIL for target 1 season(s). |
| Production-ready exit criteria | FAIL | Coverage remains pending or failing for multiple required gameplay, long-horizon, and external-secret criteria. |

## Run Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: http://127.0.0.1:3101
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
- Commissioner settings propagation scenario disabled; set E2E_ENABLE_SETTINGS=1 to exercise D.SET.3.
- Weekly starter-only scoring/finalization scenario enabled through E2E_ENABLE_SCORING=1.
- Schema preflight passed: post-refactor RPCs and required columns are present.
- Perf metrics written to tests/artifacts/perf-metrics.json.
