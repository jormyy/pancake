# Database capacity

## Evidence boundary

The initial October 28 restore occupies 168,815,763 bytes in the private database.
This measures stored data, indexes, catalogs, and database overhead.
It does not measure a day's growth, sustained disk traffic, or a supported user count.
The corrected exclusive stack completes 52 calls across all 26 stable screen functions.
Earlier attempts fail during startup.
The historical unlogged window passes both days, thirteen games, and 4,154 live-score checks.

The current [storage forecast](#final-layout-season-forecast) uses the verified corrected replay with intact statement counters.
Earlier figures remain historical comparisons. No sample establishes a hosted capacity limit.
The [health report](db-health.md) records the baseline, interruption, and remaining gates.

## Final-layout season forecast

The verified logging-off sample spans two simulated days on source `7ade191c869f4a1c8783bdae9dd49af9ca82855e`.
It completes 13 games and 450 stat rows with intact statement counters.
The sample uses the production-shaped backup and synthetic historical boxes on its restored calendar.

| Quantity | Measured or projected value |
| --- | ---: |
| Database before | 237,800,595 bytes |
| Database after | 242,936,979 bytes |
| Net allocation per simulated day | 2,568,192 bytes |
| Remaining days through April 11 | 163 |
| Linear season-end allocation | 661,552,275 bytes |
| Recorded regular-season games | 1,200 |
| Full-season model | 1,230 games |
| Remaining rows under the 1,230-game model | 39,773 |
| Remaining stat allocation at current row density | 23,252,790 bytes |
| CPU mean / p95 / peak | 0.674 / 1.168 / 2.107 cores |
| Peak database container memory | 977.600 MiB |
| Peak database connections | 29 |

The linear estimate includes reusable pages and retained logs.
The separate stat model uses observed players per game and current allocated bytes per stored stat row.
It assumes a full 1,230-game schedule; the restored calendar currently contains 1,200 regular-season games.
Neither model predicts league creation or a different request mix.
Allow separate space for WAL, backups, and maintenance. Diagnostic captures are excluded.

Four cores and four GiB remain a validation starting point for this measured workload.
The sixty-connection Micro limit is not a validated capacity target.
Keep work memory at four MiB; the spill experiment supports no increase.
The worker cap permits four active work items. Its paired probe reduces peak backend memory from 275.4 to 240.2 MiB.
The whole-container replay value includes shared buffers, cache, and other database processes.

## Storage baseline

| Relation | Rows after analyze | Total bytes | Share of database |
| --- | ---: | ---: | ---: |
| `public.player_game_stats` | 245,097 | 113,082,368 | 66.99% |
| `public.sync_runs` | 10,674 | 6,283,264 | 3.72% |
| `public.weekly_lineups` | 7,360 | 4,988,928 | 2.96% |
| `public.edge_invocations` | 10,533 | 3,932,160 | 2.33% |
| `analytics.player_season_totals` | 3,817 | 1,826,816 | 1.08% |
| `public.notification_outbox` | 257 | 303,104 | 0.18% |

Player statistics account for 53,231,616 table bytes and 59,850,752 index bytes.
That is about 461 allocated bytes per estimated row, including indexes.
Page allocation, free space, and TOAST make this an observed average, not a fixed row size.

The restored private instance has 128 MiB shared buffers, 4 MiB work memory, and 100 maximum connections.
Those are local settings, not validated capacity recommendations.
The observed sample has zero waiting sessions and zero idle transactions.

## Capture a valid growth window

Keep the same source, server, fixtures, and workload throughout the measurement.
Take the first snapshot after restoration, warmup, and counter reset.
Take the second after two simulated days and scheduled retention.
Record simulated time separately from elapsed wall time.

```sh
node scripts/db-health/index.mjs --output ../evidence/day-zero.json
node scripts/db-health/index.mjs --output ../evidence/day-two.json
node scripts/db-health/index.mjs --compare ../evidence/day-zero.json ../evidence/day-two.json 180
```

The comparison command uses elapsed capture time unless explicit simulated days are supplied.
Its `180` argument is an example horizon, not a measured season duration.
An accelerated simulation supplies its simulated-day interval as the final comparison argument.
The guarded two-day runner always supplies two days and records the capture interval separately.
The command refuses reversed times, another database, and another server start.
It reports negative allocation changes without hiding them.

## Projection worksheet

| Quantity | Calculation |
| --- | --- |
| Net bytes per simulated day | `(bytes_after - bytes_before) / simulated_days` |
| Net season bytes | `bytes_before + net_daily_bytes * season_days` |
| Rows per game | `new_stat_rows / completed_games` |
| Stat storage for the remaining schedule | `rows_per_game * remaining_games * measured_bytes_per_row` |
| Retained log storage | `daily_log_bytes * retention_days` |
| Average buffer-read byte rate | `delta_shared_read_blocks * 8192 / elapsed_seconds` |
| Average WAL rate | `delta_wal_bytes / elapsed_seconds` |
| Logical buffers per call | `(delta_shared_hits + delta_shared_reads) / delta_calls` |

Measure each phase separately: live scoring, overnight finalization, lineups, waivers, trades, forecasts, and retention.
Use the busiest measured phase when comparing compute and storage limits.
Include temporary-file writes, checkpoints, vacuum, and index writes in the disk budget.
Average rates alone do not establish peak latency or available headroom.
Buffer reads can come from the operating-system cache; they do not measure device throughput.
Use top-level statement counters for totals, since adding nested counters counts the same work again.

Retained logs reach a bounded size only after retention catches up.
Preserved failures, newest-per-function rows, pending work, and durable product history need separate counts.
Partition retention must preserve unique keys, replay receipts, foreign keys, and trigger behavior.
Dropping a partition cannot replace those correctness checks.

## Required next measurement

Use the assigned exclusive private stack and the guarded database window.
Restore the same backup, run the screen walk, then run both simulated days.
Retain before/after plans and identical result hashes for each proposed migration.
Refresh both migration attestation files after each verified migration.
Choose compute only after the peak-phase latency and disk measurements pass the same workload.

## Current decision

Keep the measured storage baseline as the starting point.
Do not select a compute tier from the failed startup trace.
Use statement logging off for workload timing.
Capture plans separately and retain the measured logging comparison.
Separate profiling overhead from worker time before setting phase limits.
Record completed games, inserted rows, retained log rows, elapsed time, and simulated time with the growth snapshots.

## Historical verification before partitioning

The six reviewed identity conflicts are resolved.
The calendar preserves recorded weeks until all thirty teams have 82 games.
Before ranking-job retirement, all 852 restored ranking rows survive the real parser without value changes.
The replay also advances a sleeping worker after its HTTP request times out.
The completed receipt covers October 29 and 30. The new partition layout still needs its own two-day receipt.
A 500-player identity-link sample improves from 2,215.504 ms to 186.878 ms with identical results.
That sample measures one database path, not supported users or season capacity.

```sh
pancake db-health --compare ../evidence/day-zero.json ../evidence/day-two.json 174 2
```

This example uses a 174-day horizon and two simulated days.
Use the measured calendar length for the actual run.
A passing workload receipt remains required before treating this output as a season forecast.


The controlled 500-player call has a 168.687 ms median without statement logging and 602.308 ms with logging.
Three pairs produce identical hashes.
Keep logging overhead separate from production compute sizing.
The full attempts end at different startup failures, so their 27.592-second and 56.229-second durations are not comparable capacity windows.


## Retention and counter measurements

Beacons and request receipts now use monthly partitions.
Retention keeps their existing 30-day and seven-day policies.
It drops complete expired months and limits boundary deletion to 5000 rows per call.
An instrumented 10000-receipt cycle records 16.501 ms before and 4.264 ms after.
Its shared-buffer count falls from 21101 to 1612; WAL falls from 1300000 to 111780 bytes.
Nested plan capture is enabled for those plan records.
Repeat retention latency timing with logging off; the current figures support the buffer and WAL comparison only.

The comparison output now includes top-level statement deltas and wall-clock rates.
It sums identical query IDs across roles and excludes nested statements from totals.
It reports missing query IDs and refuses changed reset times or decreasing counters.
`bufferReadBytesPerSecond` counts PostgreSQL buffer reads, which can hit the operating-system cache.
`walBytesPerSecond` measures statement WAL, not total disk traffic.
The host supplies capture times; the report preserves the database's simulated time separately.
A linear allocation projection does not establish retention steady state or peak compute capacity.

## Replay prerequisites

Checkpoint capture requires `pg_dump` and `pg_restore` on the mini's path.
The supplied tool directory exposes `psql`; the adjacent PostgreSQL client directory contains the other two programs.

```sh
export PATH="$HOME/pancake-local/tools:$HOME/pancake-t_4ba51e0d/tools/pg/bin:$PATH"
```

A data-only restore also needs every partition named by the saved dump.
Recreate saved partition boundaries before loading rows when retention has dropped a partition.
Restore partition metadata with the same data snapshot.
Run `ANALYZE` after resetting counters when recording table-row estimates.

## Partition growth accounting

The health snapshot records each table's partition root.
Growth comparison adds the parent's leaf tables before calculating change.
New monthly partitions therefore contribute to growth in the same parent row.
A regression test rejects the earlier result, which omitted new partitions.
The revised comparison passes all ten focused health checks.
The live PostgreSQL snapshot resolves all eight current leaf partitions to their parents.

## Invocation retention measurement

Monthly invocation partitions retain the existing seven-day success and thirty-day failure policies.
The newest success and failure for each function stay available.
A 10000-row fixture produces 1380062 WAL bytes before partition dropping and 27135 afterward.
Its unlogged execution falls from 57.635 ms to 21.512 ms with the same retained row.
The restored small-table probe rises from 27.069 ms to 32.775 ms.
Partition metadata checks add fixed work, while full-month drops reduce work as history grows.
The two-day forecast remains pending; these measurements do not establish season capacity.

## Bulk publication planning

Fresh trade values can leave a cached plan expecting one row where 450 rows now exist.
The reproduction scans season totals repeatedly and takes 2740.850 ms.
Refreshing statistics after publication reduces the same unlogged query to 58.431 ms with identical values.
This is a query measurement, not a season forecast.
The instrumented startup capture uses an extended diagnostic timeout and cannot establish acceptance or capacity.

## Current starting allocation

The unlogged window starts from 190966931 database bytes after replay preparation.
Player game statistics occupy 113442816 bytes, including indexes.
This is a new baseline, not a measured season increase.

Normalize game-stat growth by observed games and the final scheduled game count.
Use elapsed simulated days for background jobs.
Apply retention bounds to log forecasts instead of multiplying every log's growth by a full season.
Keep new-league storage separate because this window starts after league creation.

## Completed unlogged forecast

The measured interval runs from October 28 at 09:52:46.161 to 11:01:26.341 UTC.
It represents October 29–30 on source commit `0c4aa955`, before the stats and outbox partition changes.
Both days pass. Thirteen games add 450 stat rows. The run takes 4,120.18 seconds after preparation.

| Measure | Value |
| --- | ---: |
| Starting database | 190,966,931 bytes |
| Ending database | 196,758,675 bytes |
| Net allocation over two simulated days | 5,791,744 bytes |
| Net allocation per simulated day | 2,895,872 bytes |
| Season dates | October 20, 2026–April 11, 2027 |
| Season duration | 174 days |
| Remaining days after October 30 | 163 |
| Linear remaining allocation | 472,027,136 bytes |
| Linear season-end database | 668,785,811 bytes, about 638 MiB |

This model repeats the observed allocation rate for each remaining day.
It includes logs, queue churn, caches, and page allocation. It does not separate reusable space from durable growth.
Retention and vacuum can reduce that rate. A different league count or workload can increase it.
Use twice this estimate, about 1.25 GiB, as a data-space planning allowance before WAL and backups.
Recompute it after the new partition workload and retention review.

The game model provides a separate check.
The sample produces 34.62 stat rows per game and stores about 462.77 bytes per existing stat row, including indexes.
Seventy-seven season games already have rows. A complete 1,230-game season leaves 1,153 games.
That projects 39,912 more stat rows and 18,470,062 bytes, about 17.6 MiB, for durable stats.
Only 1,200 season games are currently published; the model includes thirty further games.
The new partition indexes can change the per-row cost.

## Compute starting point

The sampler records 1,324 observations during the measured interval.
CPU averages 0.73 cores, reaches 1.30 cores at the 95th percentile, and peaks at 2.42 cores.
Database memory peaks at 913,833,984 bytes, about 872 MiB. Connections peak at 25.
No sampled session waits on a database lock.

Validate the next workload on four vCPUs and four GiB of memory.
The observed CPU peak needs 3.46 cores to stay below 70% utilization.
Twice the observed database memory peak needs about 1.70 GiB; four GiB leaves room for system and query memory.
Test a 32-connection pool with the existing four-MiB work memory setting.
These are sizing assumptions, not measured limits on that configuration.

Tracked top-level statements generate 315,303,049 WAL bytes and read 25,354,240 buffer bytes.
There are no recorded temporary-block writes. Average measured WAL is 76,527 bytes per wall second.
The warm-cache read rate is 6,154 bytes per wall second. This does not establish cold-read or storage peak capacity.
The run includes checkpoint copies and measurement queries; API-only throughput is not isolated.

Statement and duration logging are off for the timing sample.
The separate matched control has medians of 168.687 ms off and 602.308 ms with nested plan logging, a 3.57-fold increase.
Those three paired probes have identical result hashes. They are not a full-workload overhead ratio.

The restored post-migration layout uses 477.39 bytes per stat row, including indexes.
That density gives 19,053,285 bytes for the same remaining-row estimate.
It is a layout sensitivity check until the new unlogged workload completes.

## Corrected outbox measurement

The monthly outbox layout is reverted after its insert regression.
Three per-row identity guards account for most of the added work.
A matched 100-message probe falls from 32.222 ms to 1.291 ms with native unique indexes.
The original pre-partition probe is 1.221 ms.
Queue reads use nineteen buffers after correction, versus ninety-four in the original probe.
The correction preserves all fifty-two screen results and all logical message rows.

Keep the completed forecast above as a historical planning scenario.
The completed corrected-layout window below supplies the final growth and compute sample.
Outbox retention now uses bounded terminal-row deletion, not monthly partition drops.
Pending work remains durable. Insert vacuum settings reduce accumulated dead rows between vacuum runs.

## Completed corrected-layout window

The October 29–30 replay passes both days, thirteen games, 450 stat rows, and 4,154 live checks.
The complete receipt includes final-stat, scoring, and worker-drain checks.
Statement logging stays off. The elapsed capture interval is 3,626.390 seconds.

| Measure | Observed value |
| --- | ---: |
| Database before | 234,712,211 bytes |
| Database after | 241,216,659 bytes |
| Allocation change over two simulated days | 6,504,448 bytes |
| Allocation change per simulated day | 3,252,224 bytes |
| Season length | 174 days |
| Remaining days after October 30 | 163 days |
| Raw linear end allocation | 771,329,171 bytes |
| New stat rows per game | 34.615 |
| Remaining games under the 1,230-game model | 1149 |
| Estimated remaining stat rows | 39,773 |
| Estimated remaining stat allocation | 23,248,818 bytes |

The raw linear estimate extends this sample's allocation change across the remaining days.
It includes log growth, free space, index pages, and catalog work.
It does not model retention steady state or guarantee device capacity.
The imported calendar contains 1200 games; the full-season scenario uses 1,230.
The stat estimate uses the measured allocated bytes per stored stat row.

| Database resource | Observed value |
| --- | ---: |
| Mean CPU cores | 0.668 |
| 95th-percentile CPU cores | 1.144 |
| Peak CPU cores | 2.435 |
| Peak container memory | 1,071.1 MiB |
| Peak database connections | 27 |
| Samples with lock waits | 0 of 1176 |

Use 4 database cores as a comparison point for this measured peak at seventy-percent utilization.
Allow at least 2,142.2 MiB for twice the observed database-container memory peak.
These figures cover the database container, not the Edge workers or the complete host.
Validate the same peak phase before selecting hosted compute.
A two-day sample does not establish production concurrency or cold-cache performance.

The separate matched 500-player control measures 168.687 ms with logging off and 602.308 ms with logging on.
Its three matching result-hash pairs isolate profiling overhead from changed application work.
The current replay wall time is not a matched logging comparison.
All-statement plan review and the remaining read/write audits are still open.

## Release 2.6.2 measurement boundary

The completed timing sample uses source `d03b95cb`, before the release 2.6.2 career-trigger change.
The merged release passes its local contention check, but that test is not a new season-capacity measurement.
The separate logged replay supplies query plans and cannot replace logging-off timing.
Retest capacity after any further layout or write-path change.

The release 2.6.2 logged replay stops at a notification claim timeout before day-one tipoff.
Its incomplete allocation sample is excluded from the season forecast.
The claim fix reduces matched logging-off time from 3,181.390 ms to 452.023 ms.
That single-call gain does not establish new daily throughput or season capacity.
A complete logging-off replay must validate the new function before refreshing this forecast.


The new detached timing run uses the 649-migration claim fix with statement logging disabled.
Concurrent audit probes use another database in the same private PostgreSQL container.
Its final allocation change can be read separately, but its compute samples include that additional audit load.
Do not replace the earlier clean compute baseline with these samples without that qualification.

The current replay preserves its starting 649-migration schema.
Three later migrations pass isolated restored-data checks while that replay runs.
They gate unchanged forecast writes, remove a redundant roster index, and index pending invocation checks.
Their individual gains do not establish a new season-wide allocation or compute estimate.
Record the completed replay first, then verify the final migration set before accepting the forecast as current.

## Micro memory boundary

The documented [Micro allocation](https://supabase.com/docs/guides/platform/compute-and-disk) is one GB.
[PostgreSQL memory limits](https://www.postgresql.org/docs/17/runtime-config-resource.html) apply per sort or hash operation, and parallel workers can multiply usage.
The private stack uses a hash-memory multiplier of two and allows two parallel workers per gather.
Sixty concurrent eight-MiB sorts alone allow 480 MiB; sixteen-MiB sorts allow 960 MiB.
One hash operation per connection doubles those amounts before shared buffers, backend memory, or other plan nodes.
These settings cannot establish a safe sixty-request Micro budget.

The function-local experiment keeps every `work_mem` setting at its existing four MiB.
It finds no spills at four, eight, or sixteen MiB across 495 measured calls.
The higher settings therefore add zero bytes to the accepted concurrency budget.
This decision does not prove that sixty simultaneous heavy requests fit in Micro.
The earlier measured container peak already exceeds one GiB, and final concurrency validation remains required.

Daily analysis uses sixteen-MiB maintenance memory in one task at a time through the existing serialized dispatcher.
It does not raise session or role memory defaults.
Fifteen table tasks add fifteen work items per UTC day, subject to the existing work-item retention.
An initial pass across the restored tables takes 1.096 seconds including fifteen client startups.
This maintenance cost prevents stale statistics; it is not an application latency gain.

## Completed replay with incomplete statement totals

The current checkpoint completes October 29–30 on source `4ced613b`, with thirteen games, 450 stat rows, and 4,154 live checks.
The outer reporter fails after simulation completion because statement counters decrease.
The recovered storage comparison keeps the original failure visible and publishes no statement throughput or WAL totals.
The interval lasts 3,698.321 seconds with statement logging disabled.
Concurrent audit work shares the PostgreSQL container, so its resource samples do not isolate replay compute.

| Quantity | Measured or projected value |
| --- | ---: |
| Database before | 234,572,947 bytes |
| Database after | 241,937,555 bytes |
| Allocation over two simulated days | 7,364,608 bytes |
| Allocation per simulated day | 3,682,304 bytes |
| Remaining season days | 163 |
| Raw linear season-end allocation | 842,153,107 bytes, about 803 MiB |
| Remaining stat rows under the 1,230-game model | 39,773 |
| Remaining allocated stat storage | 23,255,438 bytes |
| Resource samples | 911 |
| Mean / p95 / peak CPU cores | 0.715 / 1.414 / 2.319 |
| Peak container memory | 1,076.224 MiB |
| Peak primary-database connections | 31 |
| Samples with lock waits | 0 |

The linear estimate includes log growth, page allocation, and reusable space.
Twice that estimate is about 1.57 GiB before WAL and backups.
The observed CPU peak requires 3.31 cores at seventy-percent utilization.
Twice the observed memory peak is about 2.10 GiB.
Four cores and four GiB remain a validation starting point, not a proven hosted capacity limit.
The run precedes release 2.6.3 and the new maintenance and query changes.
A final isolated run must validate those changes and retain intact statement counters.

## Latest replay storage interruption

The latest run passes October 29 and stops during October 30 when the private Docker disk fills.
The accepted forecast above still needs a complete run on the current layout.

Archival recovers 40,593,342,225 bytes from 965 closed PostgreSQL diagnostic logs.
The verified compressed copies occupy 1,833,470,154 bytes.
Each copy passes decompression, length, and SHA-256 checks before its source is removed.
Keep diagnostic log storage separate from the application growth forecast.
The next logged capture archives closed files while the workload runs.

## Worker concurrency bound

Migration `20261201001000` permits four active work items and at most four starts in each dispatcher pass.
The production schedule invokes that dispatcher each minute.
A queue fixture confirms that all eight items finish across two batches.

Three paired probes execute the same eight authenticated player-screen reads with eight open database connections.
Each read retains its result for 1.5 seconds.
Median peak anonymous resident memory falls from 275.4 MiB with eight concurrent reads to 240.2 MiB with four.
The baseline for eight idle connections is 25.94 MiB in both variants.
Every result hash remains identical.
These are PostgreSQL process measurements, not Edge-runtime or whole-instance memory measurements.
The full replay must verify scheduling and whole-instance peaks after this cap.
