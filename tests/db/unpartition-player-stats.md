# Player statistics table cost

The [rollout follow-up](unpartition-migration.md) supersedes the migration timings and transaction steps below.

The regular table removes the planning cost of opening 70 partitions on each fresh connection.
The supplied backup has 245,097 rows. Production has 245,522 rows, so these results describe the supplied backup.
The private database uses one CPU and 1 GiB of memory. No production service is contacted.

## Results

The trivial player query drops from 15.86 ms to 0.35 ms median planning time.
Its fresh p95 planning time drops from 24.89 ms to 0.80 ms.
Median fresh buffers drop from 14,116 to 289.
The slowest screen fresh p95 is 77.09 ms. The slowest warm p95 is 50.99 ms.
Every measured screen stays below 3,000 warm buffers; the largest p95 is 2,516.
Warm version reads have a 0.12 ms p95. Trade legality stays below 100 ms.

Full tables (external evidence) cover 27 screen functions, three supporting reads, one simple query, and five worker operations.
Generated results (external evidence) include separate planning and execution distributions, row counts, nested statements, and index use.
Each before/after pair has five interleaved samples, both fresh and warm.
Each fresh sample opens a new PostgreSQL connection.
Each warm sample follows five calls on that same connection.
Outer execution includes planning inside PL/pgSQL functions. Outer planning alone does not measure that work.
Nested traces capture every statement with ANALYZE and BUFFERS. Their execution totals overlap across calling functions.
The table shows the largest nested statements by buffers and time, averaged across seven traced invocations.
Raw traces remain in the private benchmark evidence folder.

The isolated benchmark reproduces the fresh-connection planning gap.
It does not reproduce production CPU contention or the reported two-second screen means.
No production latency reduction or game-night CPU headroom is claimed.

## Earlier changes

The game-day partition filter is removed.
On the regular table, its live-day warm median is 7.97 ms and 807 buffers, versus 1.66 ms and 472 buffers without it.
The forecast roster scope remains: warm buffers fall from 6,932 to 603.
The shared upcoming calendar remains: warm buffers fall from 4,017 to 2,625.
The shared regular-game calendar remains: warm buffers fall from 2,625 to 2,067.
These comparisons each have five interleaved samples on the regular table.

## Migration and preservation

The final migration uses an explicit transaction around copying, verification, object replacement, and maintenance cleanup.
The final rehearsal takes 3.89 seconds including the migration runner.
The table rebuild takes 3.10 seconds; its measured writer lock takes 3.07 seconds.
The copy takes 2.53 seconds and full row verification takes 0.37 seconds.
The migration retains the old table until row counts and all column values match.
It then drops the old parent and every child in the same transaction.
A deliberate failure after replacement proves that the original table and catalog return unchanged.

All 29 columns, nine original indexes, 29 triggers, two dependent views, policies, grants, and existing foreign keys survive.
The row-type function binds to the replacement table.
An extra preservation fixture covers an incoming foreign key, column grants, comments, a row-type function, and publication membership.
A native unique ID index supplements the existing composite primary key and identity trigger.
The partition registry and its worker functions are removed. Durable statistics remain outside log retention.

Pause workers, let active work finish, apply the migration, analyze the table, verify reads, then resume workers.
The [release notes](../../supabase/RELEASE-DB.md) give the rollout sequence and expected lock time.

## Repeat the private benchmark

Use only the supplied private project and its 621xx ports.
Run database commands on the mini with the tool PATH, Docker socket, and PERF_LAB variables from the task.
Keep cron disabled and the local HTTP fence active throughout the rehearsal.
Restore the hashed backup with the existing setup command. Keep that command running until cleanup.

```sh
node tests/db/screen-view-costs.mjs --setup
```

Use a second terminal for the remaining commands:

```sh
node tests/db/unpartition-player-stats.mjs --inventory
node tests/db/unpartition-player-stats.mjs --clone
psql postgresql://supabase_admin:postgres@127.0.0.1:62122/l3_regular -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261213000200_unpartition_player_game_stats.sql > ../unpartition-evidence/migration-final.log 2>&1
psql postgresql://supabase_admin:postgres@127.0.0.1:62122/l3_regular -X -v ON_ERROR_STOP=1 -c 'ANALYZE public.player_game_stats'
node tests/db/unpartition-player-stats.mjs --contract
node tests/db/unpartition-player-stats.mjs --preservation
node tests/db/unpartition-player-stats.mjs --atomic-check
node tests/db/unpartition-player-stats.mjs --parity
node tests/db/unpartition-player-stats.mjs --capture --label=final
node tests/db/unpartition-player-stats.mjs --review
cp ../unpartition-evidence/review-samples.json ../unpartition-evidence/calendar-review-samples.json
```

The review compares each earlier change separately on the regular table.
The report consumes the saved calendar and live-day review captures, migration log, contract, parity, and rollback control.
Run `node tests/db/unpartition-player-stats.mjs --report` to enforce timing limits and regenerate the results.
The planning guard must reject the partitioned baseline and accept the regular table.
The parity suite corrupts one byte to prove its comparison rejects a mismatch.
The SQL cost recipe also rejects deliberate time and buffer violations.

Stop the setup command through its evidence stop marker after all checks finish.
It stops the private stack and deletes copied backup data.

## Verification

Exact serialized JSON matches for 366 cases across three members and two calendar days.
The fixtures include games in progress and a day without games.
Worker coverage includes refresh completion, forecast preparation and computation, a real live-stat batch, and trade revaluation inputs.

The regular-table and forecast-index recipes pass.
The log and event partition recipes still pass.
Retention, average refresh, trade revisions, screen parity, and SQL cost guards pass.
The three-season simulation and two-season durability recipe pass.
Concurrent cross-season identity and outbox conflicts both pass.

The fixture repairs preserve test intent on a populated backup.
The common fixture reuses an existing matching NBA game.
The average-write observer permits its definer to record writes.
The retention fixture supplies a rolled-back dispatcher row when private setup disables cron.

The final Node 22 run passes 4,637 tests and skips 48, with no failures.
It passes 487 files and skips 16. The full suite runs once.
All 14 SQL recipes and both concurrent identity tests pass.
Lint, application types, test types, function sources, live catalog checks, and generated attestation checks pass.
The benchmark contains 720 measured samples and 72 complete nested traces.

## Changed files

Canonical SQL includes `public/view_game_day.sql`, `public/get_prepared_matchup_forecast_context.sql`, and `public/get_league_projection_rows.sql` from the full lane.
This round also changes `private/guard_player_stats_identity.sql` and `private/drop_expired_log_partitions.sql`.
It removes `private/ensure_player_stats_partition.sql` and `private/retain_player_game_stats.sql`.
All canonical paths start at `supabase/sql/functions/by-name/`.
The migration files are `20261213000100_screen_view_costs.sql` and `20261213000200_unpartition_player_game_stats.sql`.

This round adds `tests/db/unpartition-player-stats.mjs`, `unpartition-catalog.sql`, `unpartition-preservation.sql`, this recipe, and the generated result files.
It updates `screen-view-costs.mjs`, `screen-view-costs.md`, `excellence-stats-partitions.sql`, `forecast-inputs-bound-regression.sql`, `partition-identity-isolation.sql`, and `trade-revaluation-pressure.py`.
It repairs `excellence-fixture.sql`, `refresh-player-averages.sql`, and `retention-pruning.sql`.
The generators update `supabase/sql/function-catalog.json`, `tests/e2e/release-history-attestations.json`, and `tests/e2e/db-security-catalog-attestations.json`.
The rollout and data-flow notes change in `supabase/RELEASE-DB.md` and `docs/data-flow.md`.
