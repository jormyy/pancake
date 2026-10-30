# L4 game-night safety

The emergency comparison starts from `892b6bca`, release 2.10.2.
It excludes the unfinished trade-scan study, preserved on `climb/l4-scan-study-preserved`.
The private stack is `pt4bafablel4` on ports 623xx.
Postgres has 1 GiB of memory. Squeeze measurements use 0.25 CPU.

The live-score regression recipe fails on main after the normal score publisher changes a matchup from zero to 25 points.
Its cached matchup totals stay at zero in `shed` when four workers are busy.
The essential `refresh-live-matchups` kind fixes this within one dispatch.
It copies authoritative matchup points for current matchups with games started today.
Each statement consumes at most eight pending matchups.
Repeated changes in the same minute produce another refresh even when the heavy screen version coalesces.
Standings, averages, and trade values can wait.
The focused recipe passes eleven checks, including the eight-row bound and its continuation.

Forecast invalidations now insert scoped requests instead of fingerprinting matchups in the hint drain.
Indexed requests and cache-expiry deadlines wake the forecast worker.
Each worker statement fingerprints one matchup.
Pending invalidations prevent an older forecast computation from publishing.

Notification input changes insert a coalesced dirty marker.
The dispatcher checks the marker and enqueues a scan.
The worker opens its scan in a short transaction and then visits one league member per statement.
First-scoring-day results are shared across a scan.
Score publishers do not lock the scan cursor.
Worker calls pause for 100 real milliseconds and yield after 64 chunks.
The two new worker kinds leave one admission slot for urgent work.

The focused SQL gate passes fourteen recipes, including 210 numbered assertions.
The live-score recipe includes a second score change within the same coalesced screen version.
The notification recipe compares event keys, recipients, and payloads with the previous producers.
Forecast recipes cover expiry wakeups, concurrent invalidation, and rejection of stale completions.
Five worker tests, 827 focused Vitest assertions, and 353 season-harness tests pass.
Typechecks, lint, and the quality check pass.
The full Vitest suite is not repeated.

The paired squeeze study passes five alternating baseline/candidate pairs with ten minute ticks per trial.
Both variants use the same ten-member league and eight live games.
The database is limited to 0.25 CPU and 1 GiB.
Each candidate worker statement has a 200 ms timeout.
The study executes the installed cron commands through SQL; it excludes Edge execution and native pg_cron launch delays.
It records shared buffers and WAL bytes, rather than API transfer bytes.
It rolls back every trial and stops the private stack before releasing the lock.

The measured code is `1b759ee8bc22523d4ef9de0379033ff3d7e1af1d`.
The capture is `evidence/cron-squeeze.json` in the private lane folder.
All 1,700 statements pass, including 50 calls per cron per variant, 800 forecast chunks, and 600 notification chunks.

| Cron | Before p95 / max ms | After p95 / max ms |
| --- | ---: | ---: |
| io-hint-drain | 1,095.121 / 1,193.488 | 31.732 / 66.401 |
| work-dispatcher | 1,267.972 / 1,294.213 | 84.637 / 178.774 |

Forecast chunks have p95 96.869 ms and max 139.112 ms.
Notification chunks have p95 103.556 ms and max 197.029 ms.
Each statement passes its 200 ms timeout.
The notification maximum leaves little margin; larger workloads remain a replay gate.

| Measured SQL scope | Variant | DB ms/min | Calls/min | Shared buffers/min | WAL bytes/min |
| --- | --- | ---: | ---: | ---: | ---: |
| Both minute crons | Before | 1,247.406 | 2 | 64,201.24 | 13,338.40 |
| Both minute crons | After | 34.426 | 2 | 1,570.90 | 16,078.88 |
| Crons, score publication, and chunk RPCs | Before | 1,567.357 | 3 | 68,816.90 | 24,525.02 |
| Crons, score publication, and chunk RPCs | After | 1,205.027 | 31 | 69,818.58 | 42,160.92 |

Cron DB time falls 97.2% and buffers fall 97.6%.
Each baseline trial takes 1,182–1,341 cron ms/min; each candidate takes 23–42 ms/min.
This exceeds both the observed spread and the ten-percent noise floor.
Total measured SQL time averages 23.1% lower, but the candidate trial spread exceeds that gain.
There is no total DB-time or CPU-headroom claim.
Chunking increases RPC count and queue writes.
WAL varies with full-page writes, so its mean change is not a retained byte gain.
API bytes and Edge invocation bookkeeping are excluded from this comparison.

An unpaced pilot exceeded the worker statement cap under the CPU quota.
Its timings are diagnostic evidence and are excluded from the paired result.
The final paced comparison passes without relaxing either timeout.

Deploy the updated `refresh-views` Edge worker before release 2.11 migrations 035, 036, and 037.
This package does not require the unshipped trade-scan migrations 026–028.
The replay, urgent due-to-done comparison, cold restart, stress, and recovery remain separate gates for that study.
