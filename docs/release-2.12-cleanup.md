# Release 2.12 cleanup

Raw measurement outputs are reproducible through the retained lane recipes.
No removed JSON file is imported or read as a test fixture.
Sizes are bytes immediately before deletion.

| Removed path | Bytes |
| --- | ---: |
| `tests/db/league-actions-delete-result.json` | 79,253 |
| `tests/db/league-actions-dynasty-rankings-result.json` | 82,270 |
| `tests/db/league-actions-dynasty-result.json` | 82,337 |
| `tests/db/league-actions-frozen.json` | 41,301 |
| `tests/db/league-actions-production.json` | 23,939 |
| `tests/db/league-actions-projection-result.json` | 70,823 |
| `tests/db/league-actions-results.json` | 1,905,040 |
| `tests/db/league-actions-table.md` | 10,838 |
| `tests/db/league-actions-visible-result.json` | 102,168 |
| `tests/db/lineup-draft-quality.json` | 133,182 |
| `tests/db/lineup-draft-results.json` | 1,069,424 |
| `tests/db/lineup-draft-validation.json` | 1,030 |
| `tests/db/perf-l4-statistics-results.json` | 46,777 |
| `tests/db/perf-l4-statistics-verify-results.json` | 958 |
| `tests/db/roster-actions-baseline-tests.json` | 1,013 |
| `tests/db/roster-actions-control-cost.json` | 1,342,437 |
| `tests/db/roster-actions-core-cost.json` | 1,638,680 |
| `tests/db/roster-actions-final-cost.json` | 1,594,874 |
| `tests/db/roster-actions-final-parity.json` | 185,833 |
| `tests/db/roster-actions-frozen.json` | 282,719 |
| `tests/db/roster-actions-game-lock-cost.json` | 394,358 |
| `tests/db/roster-actions-game-lock-parity.json` | 282,719 |
| `tests/db/roster-actions-game-lock-tests.json` | 1,013 |
| `tests/db/roster-actions-http-gate.json` | 59,063 |
| `tests/db/roster-actions-roster-lookup-cost.json` | 46,587 |
| `tests/db/roster-actions-roster-lookup-parity.json` | 259,634 |
| `tests/db/roster-actions-roster-lookup-tests.json` | 203 |
| `tests/db/roster-actions-scheduled-worker-cost.json` | 235,435 |
| `tests/db/roster-actions-short-history-cost.json` | 134,274 |
| `tests/db/roster-actions-verification.json` | 1,715 |
| `tests/db/roster-actions-worker-projection-cost.json` | 26,670 |
| `tests/db/trades-actions-noise.json` | 330,969 |
| `tests/db/trades-actions-parity.json` | 80,130 |
| `tests/db/trades-actions-reanalysis-parity.json` | 366 |
| `tests/db/trades-actions-results.json` | 928,231 |
| `tests/db/trades-actions-samples.json` | 2,838,417 |
| `tests/db/trades-actions-verification.json` | 3,793 |

Removed 37 files, 14,318,473 bytes and 221,748 raw output lines.

Test and harness pruning:

| Removed path | Bytes | Reason and retained coverage |
| --- | ---: | --- |
| `tests/db/lineup-draft-confirm.mjs` | 1,994 | Unreferenced retry wrapper. `lineup-draft-actions.mjs` still runs warm/fresh benchmarks and mutation-checked quality comparisons through the lane recipe. |
| `tests/db/roster-actions-table.mjs` | 4,501 | Unreferenced table formatter without behavioral assertions. `roster-actions-report.mjs` and `roster-actions.test.ts` retain cost and paired-noise checks. |
| `tests/db/roster-actions-game-lock-candidate.sql` | 1,823 | Superseded function installer without assertions. The canonical function and migration 05100 retain the implementation; `roster-status-game-lock.sql` and `roster-activation-lock-order.sql` retain lock regressions. |
| `tests/db/roster-actions-roster-problems-candidate.sql` | 1,627 | Rejected experimental installer without assertions. `server-roster-legality.sql` and `tests/lib/roster-problems.test.ts` retain roster legality coverage. |

The SQL sweep discovers root SQL files automatically. Removing installers prevents a purported test from replacing functions without checking any result.
No Vitest regression file is removed. Lineup cache, roster, trade lock, auto-set, Taxi auction, and statistics-policy regressions remain.

Dead code cleanup replaces the four new lane wildcard entries in Knip with the actual recipe entry points.
Knip then identifies two unused scripts: `tests/db/league-actions-snapshots.mjs` and `tests/db/lineup-draft-keeper-guard.mjs`.
The first summarizes old measurement snapshots. The second pauses a lane process and has no product assertions.
Both are removed. The league action replay and lineup quality gate retain behavioral coverage.
The HTTP cleanup helper remains an explicit entry because the HTTP recipe invokes it through a subprocess.
No unused application export or dependency remains in the Knip report. No dependency is added.

| Removed dead script | Bytes |
| --- | ---: |
| `tests/db/league-actions-snapshots.mjs` | 3,466 |
| `tests/db/lineup-draft-keeper-guard.mjs` | 1,042 |
