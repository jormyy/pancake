# Expanded test-pruning audit

Observed at 2026-08-24T08:34:36Z.

| Measure | Before | After |
|---|---:|---:|
| Test files | 113 | 113 |
| Tests | 642 | 642 |
| Vitest time | 1.75 seconds | 1.57 seconds |
| Command wall time | 2.1 seconds | 1.9 seconds |
| Failing tests | 0 | 0 |
| Coverage | unavailable | unavailable |

No test was removed.

The repository has no coverage command or installed Vitest coverage provider.
The audit found no skipped, pending, exclusive, snapshot-only, or assertionless tests.

Seven direct behavior mutations proved the final tests can fail:

1. A redundant draft `bids` watch failed the realtime-watch contract.
2. A wrong cleanup table failed the resource-owner cleanup contract.
3. A screenshot inside the measurement window failed the capture-order contract.
4. Disabling the mixed-target guard failed the release contract.
5. Disabling the settle check failed the route-recovery contract.
6. A macOS agent screenshot mode failed the lifecycle contract.
7. Selecting the first CDP page failed the attached-target contract.

Each mutation failed its target test.
Each mutation was restored before the next check.
The final full suite passed with 113 files and 642 tests.

The navigation-order test reads source text.
It is coupled to the navigation declaration.
It remains because it is the only automated order boundary and failed when the order changed.
A rendered navigation assertion can replace it later.

The resource-order tests also remain.
They guard incident regressions and failed under direct mutations.
