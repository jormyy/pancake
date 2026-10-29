# L4c ingest cost

Base: `ec739102` (release 2.9.1).
Private stack: `pt4bafableig`, ports `630xx`.
PostgreSQL has one CPU and 2 GB of memory.
The backup was restored at migration `20261029000800`, then migrated to the lane source.
The replay fixtures are copied into the private lane folder.
Database HTTP requests are fenced to the assigned local ports.
Cron launch is disabled. The harness drives business time.

## Kept changes

The identity linker returns early for a uniquely named, already linked player whose supplied fields need no writes.
It holds the original player lock and checks the name, other provider owners, missing metadata, current roster team, and duplicate names.
All other records use the existing merge and ambiguity checks.
Injury identity writes retain their separate transactions.

Five interleaved pairs followed one warm pair.
Each sample links 100 ESPN identities from the restored backup, one record per call.
The SQL clock is fixed. Every pair compares all player columns and all RPC receipts by hash.
All five comparisons match.

| Pair | Before DB ms | After DB ms |
| --- | ---: | ---: |
| 1 | 57.193 | 34.166 |
| 2 | 61.417 | 30.782 |
| 3 | 67.742 | 33.101 |
| 4 | 67.106 | 35.428 |
| 5 | 64.857 | 35.747 |
| Median | 64.857 | 34.166 |

The median database time falls 47.3%. Every pair improves.
This is an RPC microbenchmark. It does not establish hourly job costs.
Raw samples: `tests/perf-l4c/results/identity-pairs.json`.
Run `node tests/perf-l4c/sql-bench.mjs` in the configured private mini checkout.

The CDN pipeline reuses the identity receipt returned by its side-membership import.
Each complete box uses one identity RPC instead of two.
Partial sides retain the complete-resolution fallback.
Every box still verifies current identities. Nothing is cached between boxes.
The live, final, and backfill paths share this change.

Five interleaved pairs of 100 boxes follow one warm pair.
Player rows, membership rows, and both identity receipts match in every pair.
The median database time falls from 266.457 ms to 209.734 ms, a 21.3% reduction.
Identity RPC calls fall from 200 to 100.
Raw samples: `tests/perf-l4c/results/cdn-pairs.json`.
The 41 focused Deno tests pass, including fresh identities, incomplete sides, source contention, DNPs, final scores, and concurrent fetching.
Run `node tests/perf-l4c/cdn-bench.mjs` in the private mini checkout.

The stat saver compares stored rows before attempting inserts.
Its existing conflict comparison remains as a second guard.
Game identity, source locking, completion, duplicate-player, and final-snapshot checks remain.

Each scenario has five interleaved pairs of 50 ticks.
All 15 pairs produce identical players, games, stat rows, season totals, and RPC receipts.

| Stat scenario | Before DB ms | After DB ms |
| --- | ---: | ---: |
| Unchanged rows | 333.234 | 245.854 |
| Ten changed players | 584.657 | 530.610 |
| Every player changed | 905.173 | 909.061 |

The unchanged case improves 26.2%.
The mixed case improves 9.2% in this run. An earlier run was within timing noise.
The fully changed case remains within timing noise.
Raw samples: `tests/perf-l4c/results/stats-pairs.json`.
The completion, live-snapshot-order, and final-revision SQL recipes pass.
Run `node tests/perf-l4c/stats-bench.mjs` in the private mini checkout.

The injury identity loop renews its five-minute work lease every two minutes.
It still renews before the first identity and before guarded injury writes.
The existing heartbeat, contention retries, and lost-lease checks remain.
For a short 100-identity pass, explicit renewals fall from 101 to two.
Five interleaved SQL pairs reduce median renewal DB time from 9.757 ms to 0.486 ms, a 95.0% reduction.
Every pair leaves the same stored work-item data.
All 25 focused injury tests pass, including long passes, retries, permanent failures, and lease loss.
Raw samples: `tests/perf-l4c/results/lease-pairs.json`.

Known CDN identities and unchanged game memberships are verified together in one SQL read.
The result keeps the original receipt format and verifies distinct canonical player IDs.
Missing players, missing memberships, side corrections, and the Dillon Jones aliases use the existing import path.
Metadata and game validation remain.
Five interleaved pairs of 100 boxes reduce median DB time from 223.746 ms to 92.591 ms, a 58.6% reduction.
All player rows, membership rows, and receipts match in every pair.
The eight new SQL checks and the existing CDN correction and participation guards pass.
Raw samples: `tests/perf-l4c/results/cdn-known-pairs.json`.

Both no-op shortcuts execute a zero-row update to preserve the existing statement-level work-lease fence.
Two negative controls reproduce the omitted fences in `f68eb86b`.
The repaired versions reject the same lost leases and retain their gains across five new pairs.
The raw identity and known-CDN samples above describe the repaired versions.
The stat saver counts distinct UUIDs before filtering unchanged rows.
A third negative control reproduces an accepted duplicate when the same UUID uses different letter case.
The repaired version rejects that input without changing the stored row.
The stat samples above include this guard.

## RPC sources

- `public.link_player_sources_atomic`: unchanged identity shortcut.
- `public.save_game_stats_atomic`: filter unchanged rows before the insert.
- `public.resolve_player_imports_atomic`: verify known CDN identities and memberships in one read.

Migration: `20261214001700_ingest_identity_noop.sql`.

## Job windows

The idle-hour and live-window measurements are pending.
The two-day stored-table comparison and final season harness are pending.

| Job | Idle calls/hour | Idle DB ms/hour | Live calls/hour | Live DB ms/hour |
| --- | --- | --- | --- | --- |
| live-poll | Pending | Pending | Pending | Pending |
| stats-sync | Pending | Pending | Pending | Pending |
| sync-scores | Pending | Pending | Pending | Pending |
| sync-players | Pending | Pending | Pending | Pending |
| Sleeper projections | Pending | Pending | Pending | Pending |
| FantasyPros projections | Pending | Pending | Pending | Pending |
| sync-player-injuries | Pending | Pending | Pending | Pending |
| setup-season-rollover | Pending | Pending | Pending | Pending |
| pg-net-response-vacuum | Pending | Pending | Pending | Pending |
| public-read-retention | Pending | Pending | Pending | Pending |
| edge-invocation-reconcile | Pending | Pending | Pending | Pending |

## Verification

The new source-link regression has nine passing checks.
The existing source-connectivity and exact-roster-identity recipes pass 16 checks.
The sparse-player-merge recipe uses an unused provider game ID and passes against the restored backup.
The complete lane migration applies to the restored private database.
The source-link, known-CDN, duplicate-stat, and sparse-merge recipes pass after that migration.
Final checks are pending.

## Replay configuration

The port guard is fixed by cherry-picking `989c8522` as `12a5d481`.
Lane configuration uses the assigned private project, season, and fixture paths.
Three database-window unit tests and six focused Vitest checks pass.
The production window contains 13 games on October 29 and 30, 2026.
Its 1,200 mapped calendar games use pinned historical same-team inputs and are labeled synthetic.
Provider identities and Sleeper projection inputs come from the restored backup.
The unbounded origin corpus and bounded replay corpus have separate paths.

The cost capture records HTTP request counts and server SQL durations by job.
SQL-only jobs use function counters at exact business-time boundaries.
The idle window runs from three to two hours before the first tipoff.
The live window runs from ten to forty minutes after tipoff.
The telemetry smoke passes the native-clock guard, exact boundaries, and actual RPC timing attribution.

Mini configuration:

```sh
export PATH=$HOME/pancake-local/tools:$PATH
export DOCKER_HOST=unix://$HOME/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock
export PERF_LAB_ON_MINI=1 PERF_LAB_LANE=fable-l4c PERF_LAB_PROJECT=pt4bafableig PERF_LAB_PORT_PREFIX=630
export SEASON_SIM_PROJECT=pt4bafableig SEASON_SIM_PORT_PREFIX=630 SEASON_SIM_CLI=supabase SEASON_SIM_PSQL=psql
export SEASON_SIM_ROOT=$HOME/pancake-t_4ba51e0d/lanes/fable-l4c
cd "$SEASON_SIM_ROOT/repo"
node tests/perf-l4c/prepare-window.mjs
node tests/perf-l4c/measure.mjs candidate
```

Use the same restored database state before reference and candidate measurements.
The reference mode loads application functions from `ec739102` and records that source separately.
Full hourly measurements and the two-day stored-table comparison are still pending.

## Replay tooling

The user authorized harness fixes that preserve product behavior.
The following upstream harness commits are applied with their origin recorded:

| Upstream | Lane commit | Harness fix |
| --- | --- | --- |
| `989c8522` | `12a5d481` | Validate the assigned port prefix. |
| `81157f54` | `4f849395` | Compare the complete canonical Realtime publication. |
| `8a851e99` | `ddfed6ec` | Check weekly add limits through scheduled waiver claims. |
| `757e6701` | `4445183f` | Advance the clock after completed HTTP calls. |
| `f73c5710` | `088bab34` | Recognize completed retries and refused connections. |
| `7604e4b4` | `598ff311` | Exclude completed transport calls from active worker counts. |
| `7fb3a7b1` | `2af8b5fd` | Wait for bounded replacement work. |
| `53ff4ae6` | `2e931a77` | Retain the bounded transport-timeout retry path. |
| `a67ff4a5` | `bdc76ddd` | Apply its two harness files to check the final active retry. |
| `02d82991` | `83f1016e` | Adapt its native auth hook for the private replay clock. |

The last two commits also contain unrelated files upstream. Only the harness changes were adapted.
The native auth hook adjusts the issue time before native signing and retains the other claims.
Its private token lifetime covers the simulated season. Product auth validation remains active.
Configuration changes separate the origin and bounded fixture paths, select the restored season, and select the reference function source.
The mapped fixture generator retains the historical ESPN roster identity.
The two-day trade check waits through at most 15 production minutes and still requires completion.
The paired baseline clears work created by earlier harness runs.
The work queue migration follows the restored backup schema, so those queue rows are not backup data.
Production invocation history without a harness work-item link remains.
The original dump and the cleared queue counts are retained inside the lane.
The SQL completion-marker protocol has a focused passing test.
No product dispatcher, cadence, publication, or invocation bookkeeping changes are included.

`node tests/perf-l4c/run-window.mjs` takes the shared measurement lock before starting the stack.
It records the lane and start time, captures an initial private database dump, and restores it between variants.
It stops the stack and releases its lock on success or failure.
It compares every column and row in eight ingest tables with sorted JSON byte hashes.
Failed attempts retain the initial dump for the next retry.
The initial dump is inside this lane and has mode 0600.

The mini retains `two-day.log`, component benchmark logs, restoration logs, telemetry smoke results, and both fixture directories.
Copied backup SQL files are deleted.
Full Vitest, final lint and typechecks, the season harness, hourly job costs, and the two-day table comparison remain pending.
The canonical function source check and focused script lint pass.
Do not reinstall dependencies, recopy fixtures, or repeat the retained component pairs.
