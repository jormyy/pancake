# Screen read cost checks

These are the round-one results. The [regular-table follow-up](unpartition-player-stats.md) replaces the game-day partition filter and adds fresh-connection measurements.

The database budget comes before transfer size and response time.
The benchmark uses the production-shaped backup and the release 2.7.3 source.
It runs only on the private mini stack.
Postgres has one CPU and 1 GiB of memory.

## Setup

Use the supplied bundle procedure to create the private checkout.
Copy both backup files into its sibling `backup` directory.
Record their SHA-256 hashes in `backup/manifest.json` before transfer.
Use the filenames as keys and the hashes as values.
The setup checks both hashes before it starts the stack.

Set these values in the private mini checkout:

```sh
export PATH=$HOME/pancake-local/tools:$PATH
export DOCKER_HOST=unix://$HOME/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock
export PERF_LAB_ON_MINI=1
export PERF_LAB_LANE=fable-l3
export PERF_LAB_PROJECT=pt4bafablel3
export PERF_LAB_PORT_PREFIX=621
node tests/db/screen-view-costs.mjs --setup
```

Setup disables scheduled jobs and rejects external HTTP requests.
It restores the recorded backup schema, loads the data, and applies the repository migrations.
It removes copied backup files and clears copied delivery credentials.
It verifies the container limits before it reports readiness.

## Measurements

Run these commands in another connection with the same environment:

```sh
node tests/db/screen-view-costs.mjs --inventory
node tests/db/screen-view-costs.mjs --capture --label=baseline
node tests/db/screen-view-costs.mjs --sql-guard --expect-guard-failure
node tests/db/screen-view-costs.mjs --controls
node tests/db/screen-view-costs.mjs --parity
node tests/db/screen-view-costs.mjs --parity --negative-control
node tests/db/screen-view-costs.mjs --interleave --label=game-day --function=view_home,view_lineup,view_players
node tests/db/screen-view-costs.mjs --warm-sweep
node tests/db/screen-view-costs.mjs --verify
```

The inventory selects three real managers from the largest restored league.
It prepares the selected matchup before it measures its read.
Each capture takes five cold and five warm samples per function.
Cold samples restart Postgres and clear its shared buffers.
The host file cache remains available.
Warm samples prime the same connection before the measured call.
Screen reads use the authenticated role. Worker reads use the service role.

Nested capture uses `auto_explain` with analysis, buffers, JSON, and every nested statement enabled.
It records every nested statement on both cache states.
Parent totals include child work and cannot be added together.
Node timing stays disabled. Each statement still records its total duration.
Calls without nested logging supply the latency comparisons.
Interleaved comparisons alternate the baseline and candidate order across five pairs.
Each comparison applies definitions inside a transaction and rolls them back.

The default comparison base is `1f64045b`.
Use `--base=<commit>` for a later single-change comparison.
Use `--candidate=<SQL file>` to select a separate candidate.
Do not run other database checks during a measurement.

## Correctness and guards

Parity compares serialized JSON text without normalization.
It uses three managers, every screen RPC, league tabs, and player availability filters.
It freezes the clock for one day with live game statistics and one day without games.
The candidate and baseline share one transaction, input data, and clock.
Each run rolls back its clock substitutions and fixture changes.
The negative control corrupts one expected response and requires exactly one mismatch per day.

The SQL recipe rejects a deliberately delayed query and an excessive buffer count.
It measures five warm calls after one priming call.
Views must stay below 150 ms and 3,000 buffers.
The version read must stay below 2 ms. Trade preview must stay below 100 ms.
The baseline must fail the same guard that the final candidate passes.

## Shutdown

Create `cost-evidence/stop` beside the private checkout.
The setup removes the stack and restores the checkout configuration.
Keep the measurement files until the results and commits are reviewed.

## Kept changes

| Change | Cold buffers | Warm buffers | Warm median ms | Evidence |
| --- | ---: | ---: | ---: | --- |
| Game-day pruning: home | 32,241 → 8,993 | 1,015 → 731 | 15.70 → 7.08 | Five interleaved pairs; exact JSON passes |
| Game-day pruning: lineup | 30,407 → 7,301 | 429 → 287 | 6.78 → 2.95 | Five interleaved pairs; exact JSON passes |
| Game-day pruning: players | 37,635 → 37,183 | 4,259 → 4,117 | 49.86 → 43.45 | Same comparison; further work remains |
| Forecast average scope | 35,654 → 29,323 | 6,982 → 650 | 27.61 → 10.36 | Five interleaved pairs; exact JSON passes |
| Shared projection calendar | 35,338 → 33,914 | 4,068 → 2,644 | 43.73 → 39.81 | Five interleaved pairs; exact JSON passes |
| Shared calendar validation | 34,210 → 33,657 | 2,979 → 2,419 | 40.20 → 40.89 | Five interleaved pairs; exact JSON passes |

The first three changes leave two player-date cases at 3,006 and 3,008 buffers.
Shared calendar validation brings all 114 tested warm variants below their budgets.
The final comparison covers three managers and five samples per variant.
The completion check requires 200 cold and warm samples and 40 complete nested captures.

A separate calendar-only shortcut reduces player buffers by 5.2% in the screening pair.
It fails the frozen 10% keep threshold and is fully reverted.
The slight median latency increase in the final calendar comparison remains inside the measured spread.

The restored backup makes the retention test's empty-table assumption fail on both source versions.
Run that fixture with its projection table empty inside the same rollback transaction:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -c 'BEGIN; TRUNCATE public.sleeper_projection_rows;' -f tests/db/sleeper-projections.sql
```

These isolated timings do not reproduce production CPU contention.
The supplied production means are higher than this isolated benchmark.
Warm calls reuse function plans in one connection. Cold calls include first-use planning.
Cold plans still touch many catalog pages. The numerical targets apply to warm reads.
No production timing reduction is claimed.
Setup checks both backup hashes before it changes the database.

The measurement tables (external evidence) list every requested function and the largest nested statements.
The machine-readable results (external evidence) include the comparisons and negative controls.

## Changed files

- [Game-day read](../../supabase/sql/functions/by-name/public/view_game_day.sql)
- [Prepared forecast read](../../supabase/sql/functions/by-name/public/get_prepared_matchup_forecast_context.sql)
- [Projection read](../../supabase/sql/functions/by-name/public/get_league_projection_rows.sql)
- [Migration](../../supabase/migrations/20261213000100_screen_view_costs.sql)
- [Benchmark runner](screen-view-costs.mjs)
- [SQL timing guard](screen-view-costs.sql)
- [This recipe and handoff](screen-view-costs.md)
- Generated measurements (external evidence)
- Generated tables (external evidence)
- [Generated release attestations](../e2e/release-history-attestations.json)
- [Generated catalog attestations](../e2e/db-security-catalog-attestations.json)
- [Database release notes](../../supabase/RELEASE-DB.md)
- [Data flow notes](../../docs/data-flow.md)

## Verification results

The full Node 22.23.2 unit run passes 4,635 tests and skips 48, with no failures.
It passes 487 test files and skips 16. The run uses one worker.
Lint, application types, test types, function sources, and catalog checks pass.
The SQL cost guard rejects the baseline and accepts the final candidate.
Both corrupted-JSON controls fail as expected. Both exact JSON comparisons pass all 132 cases.
The wider warm sweep passes all 114 variants with five samples each.
The completion check passes 200 cold and warm samples across all ten requested functions.
It verifies 40 complete nested captures and all 264 exact JSON comparisons.
The live-day fixture has nine games. The off-day fixture has none.

These SQL recipes pass on the final candidate:

- `view-screen-parity.sql`: 63 checks.
- `view-player-search-parity.sql`: 81 checks.
- `sleeper-projections.sql`: 61 checks, with the isolated setup above.
- `fantasypros-projections.sql` and `game-calendar-corrections.sql`.
- `matchup-forecast-season-average.sql` and `matchup-forecast-cache-parity.sql`.
- `forecast-input-write-gate.sql`: nine checks.
- `screen-view-costs.sql`: time and buffer limits, plus negative controls.

The measurements cover isolated screen reads and the listed variants.
They do not establish game-night, stress, or recovery headroom for the full platform.

The private stack is stopped. Both source checkouts are clean, and copied backups are removed.
No work remains in this lane. Reuse the recorded evidence unless the SQL or inputs change.
