# Unpartition rollout follow-up

The production attempt hits the original 60-second cap and rolls back.
The revised migration reduces copy work and raises both elapsed-time and statement caps to 300 seconds.
The lock wait cap remains three seconds.

## Measured result

The private database uses 0.25 CPU and 1 GiB of memory.
The supplied backup contains 245,097 rows across 70 partitions.
Three interleaved baseline and candidate runs use new connections.

Median elapsed time falls from 13.844 to 8.507 seconds.
Median writer lock time falls from 13.603 to 8.294 seconds.
The slowest candidate takes 10.686 seconds, including connection setup.
The gain exceeds ten percent and the observed spread.

The normal migration runner completes in 11.353 seconds at the same limit.
Budget 50 seconds for production: four times the slowest rehearsal, including the runner, rounded up.
The 300-second cap leaves six times that budget.
The bench does not reproduce the production 60-second timeout.
The new phase notices identify any remaining production delay without another blind timeout.

[Every phase](unpartition-migration-tables.md) and [all measurements](unpartition-migration-results.json) include the full comparison.
These results supersede the earlier one-CPU migration estimate.

## Cause and change

The original copy maintains ten indexes for every inserted row.
Its median copy time is 11.082 seconds at one-quarter CPU.
A separate count adds 0.112 seconds, and the full-row verification join adds 1.505 seconds.
The revised copy first writes a heap and compares its returned rows against the source with `EXCEPT ALL`.
That exact comparison includes every column and preserves duplicate counts.
Copy and verification together take 2.799 seconds.
The ten indexes then build in bulk in 4.994 seconds.
All nine original indexes and the added unique ID index remain present.

The original dependency loop recreates 31 functions. It takes 0.094 seconds at the median.
Function recreation is not the main bottleneck on this backup.
The catalog shows only one row-type dependency: `private.player_game_appeared(player_game_stats)`.
The revised dependency loop recreates that one function.
The metadata of 28 unaffected functions remains unchanged, including their catalog transaction IDs.
The three changed entries are the row-type helper and the two intentional canonical updates that name stats.

String function bodies do not create relation dependencies in PostgreSQL's catalog.
The [dependency rules](https://www.postgresql.org/docs/17/ddl-depend.html) distinguish body references from argument and result types.
A connection warmed before the swap verifies prepared SQL, cached PL/pgSQL, the scoring function's row variable, and the row-type helper afterward.
All return the same values without broad function recreation.

## Lock and validation

Policies, triggers, ownership, comments, and grants are prepared before the SHARE lock.
All copy-table triggers stay disabled during the copy and return to their original states before the swap.
The copy, exact comparison, index build, dependency repair, and swap commit together.
Index construction remains inside this window so the live table never lacks its required indexes.
The old table drops only after exact row equality passes.

Foreign keys are installed as `NOT VALID` before the first commit.
They enforce new writes immediately.
Originally validated foreign keys validate after the copy lock is released.
Originally unvalidated foreign keys remain unvalidated.
PostgreSQL documents this [validation behavior and lock level](https://www.postgresql.org/docs/17/sql-altertable.html).

A runtime check rejects validation while the session still holds the copy lock.
A two-connection test shows an update succeeds while validation holds its lock.
The negative control holds SHARE and makes that same update time out.
A separate negative control proves an unvalidated FK rejects a new invalid row.

Private migration state persists until validation finishes.
If the second phase fails, the table remains usable and rerunning the migration resumes validation without recopying rows.
A forced post-copy failure and retry exercise this path.
A failure before the first commit still restores the original table and complete catalog.

## Rehearsal

Use only the private mini stack, project `pt4bafablel3`, and ports 621xx.
Restore the supplied backup through migration `20261213000100` with the existing private setup recipe.
Keep the setup process running, cron disabled, and its HTTP fence active.
Run the following commands from the private checkout with the task's mini environment exports:

```sh
node tests/db/unpartition-player-stats.mjs --inventory
node tests/db/unpartition-player-stats.mjs --clone
docker update --cpus=0.25 --memory=1g --memory-swap=1g supabase_db_pt4bafablel3
node tests/db/unpartition-migration.mjs --dependencies --label=before
node tests/db/unpartition-migration.mjs --cached-plans
node tests/db/unpartition-migration.mjs --dependencies --label=after --database=l3_regular
node tests/db/unpartition-player-stats.mjs --preservation
node tests/db/unpartition-player-stats.mjs --atomic-check
node tests/db/unpartition-migration.mjs --resume
```

Run each baseline/candidate pair three times, with labels ending in 1, 2, and 3:

```sh
node tests/db/unpartition-migration.mjs --measure --baseline --label=baseline-1
node tests/db/unpartition-migration.mjs --measure --reset --database=l3_regular --label=candidate-1
node tests/db/unpartition-migration.mjs --report
node tests/db/unpartition-player-stats.mjs --parity
```

The baseline is the committed migration that timed out, with added notices and a final rollback.
Each candidate starts from a fresh clone of the same restored database.
The report rejects insufficient gains and unexpected function metadata changes.
The preservation probe uses a separate disposable database and exercises both real commits.
It checks extra grants, comments, indexes, views, row-type functions, publication membership, and both FK validation states.

Apply the final file through `supabase migration up --local --include-all` before generating attestations.
Run `ANALYZE public.player_game_stats` after the migration commits.
Use the repository generators for the function catalog, release history, and security catalog.
Keep workers paused until validation, analysis, and the final checks finish.
The [release notes](../../supabase/RELEASE-DB.md) describe the rollout sequence.

The screen latency recipe retains its original one-CPU contract.
At one-quarter CPU it reaches 182.456 ms and correctly fails its 150 ms guard.
It passes at one CPU without a source change.

## Final checks

The normal migration runner applies the final file at one-quarter CPU in 11.353 seconds.
Both catalog generators run against that private database, and the live catalog check passes.
All 366 screen and worker parity cases match, with both corrupted-byte controls rejected.
The preservation, cached-plan, rollback, and interrupted-validation controls pass.
All 14 SQL recipes and both concurrent identity tests pass.
The screen latency guard runs at its original one-CPU budget; the other recipes run at one-quarter CPU.
Lint, application types, test types, function sources, and attestation checks pass.
The full Node 22 suite runs once: 4,637 tests pass, 48 skip, and none fail.
It passes 487 test files and skips 16.

## Files

The migration changes in `supabase/migrations/20261213000200_unpartition_player_game_stats.sql`.
No canonical application function changes in this follow-up.
The benchmark and regression work changes `unpartition-migration.mjs`, `unpartition-player-stats.mjs`, and `unpartition-preservation.sql` in this folder.
The new results, tables, and this report also live in this folder.
The older screen report links here for the revised migration estimate.
Release and data-flow notes change in `supabase/RELEASE-DB.md` and `docs/data-flow.md`.
The repository generators update the release-history and security-catalog attestations in `tests/e2e/`.
