# Expanded test-pruning audit

Observed at 2026-08-23T20:24:00Z.

| Measure | Before | After |
|---|---:|---:|
| Test files | 112 | 112 |
| Tests | 636 | 636 |
| Wall time | 2.14 seconds | 2.10 seconds |
| Failing tests | 0 | 0 |
| Coverage | unavailable | unavailable |

No test was removed.

The audit covered all tests added after the earlier full-suite pruning pass.
The surface-matrix and navigation-order tests failed under direct behavior mutations.
Each mutation was restored before the next check.
The final full suite passed.

The navigation-order test reads source text.
It is coupled to the navigation declaration.
It remains because it is the only automated order boundary and failed when the order changed.
A rendered navigation assertion can replace it later.
