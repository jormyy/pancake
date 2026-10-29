# Slow screens

The private mini uses `pt4bafablel3d`, ports 624xx, and 1 GiB of database memory.
The baseline is release 2.8, `628c7def`.
The restored backup contains 245,097 player statistics rows.
Cron stays disabled. The database rejects external HTTP.

The runner reuses both earlier harnesses.
Each sample opens a fresh connection and measures again after five priming calls.
Five baseline/candidate pairs alternate order.
Nested traces run separately from latency samples.
`pg_stat_statements.track_planning=on` separates planning and execution for nested statements.
Parent execution includes child work. Do not sum parent and child execution times.

| Round | Change | Evidence | Decision |
| --- | --- | --- | --- |
| 1 | Cache pending trade count plans in PL/pgSQL | League warm median 0.55 → 0.40 ms. Baseline spread 0.06 ms. 264 exact JSON cases pass. | Keep. 27% warm reduction exceeds spread and 10%. Fresh calls remain below target. |
| 2 | Skip unused roster, preview, and analysis output in trade list helpers | Fresh median 18.92 → 10.41 ms. Warm median 6.05 → 2.41 ms. Warm buffers 516 → 87. Three-manager variants and 264 exact JSON cases pass. | Keep. Both time and buffer reductions exceed spread and 10%. |
| 3 | Cache projection query with a generic PL/pgSQL plan | Player warm median 24.17 → 18.16 ms. Baseline spread 4.66 ms. 264 exact JSON cases pass. | Keep. 25% warm reduction exceeds spread and 10%. Fresh calls remain below target. |
| 4 | Use a generic roster plan | Warm median 3.43 → 2.74 ms. Warm buffers 429 → 364. Baseline time spread 0.56 ms. 264 exact JSON cases pass. | Keep. 20% time and 15% buffer reductions exceed spread and 10%. |

The first isolated baseline meets the one-CPU targets.
It does not reproduce production's two-second reads.
At quarter CPU, quota throttling produces much larger latency spread.

## One CPU results

These are the largest p95 values across all three managers and all 75 screen variants.
Each variant has five interleaved baseline/candidate samples.

| Function | Before fresh p95 ms | After fresh p95 ms | Before warm p95 ms | After warm p95 ms | Before / after warm buffers |
| --- | ---: | ---: | ---: | ---: | ---: |
| view_roster | 15.46 | 13.30 | 4.59 | 2.85 | 429 / 348 |
| view_players | 41.95 | 46.34 | 33.01 | 25.01 | 2126 / 2038 |
| view_league | 6.59 | 7.05 | 2.07 | 0.81 | 159 / 155 |
| view_trades | 34.84 | 21.18 | 20.32 | 9.03 | 1451 / 539 |

Every variant passes the 150 ms fresh and 60 ms warm limits.
Projection plan retention increases some fresh calls by a few milliseconds.
It removes repeated warm planning and keeps every fresh call within the target.
The installed-migration check below excludes the function-definition substitution used for interleaving.

## Quarter CPU results

These are the largest p95 values across the same 75 cases.

| Function | Before fresh p95 ms | After fresh p95 ms | Before warm p95 ms | After warm p95 ms |
| --- | ---: | ---: | ---: | ---: |
| view_roster | 97.34 | 102.14 | 88.29 | 78.08 |
| view_players | 304.60 | 307.73 | 200.96 | 178.89 |
| view_league | 86.01 | 94.04 | 72.66 | 69.32 |
| view_trades | 195.61 | 103.81 | 97.57 | 85.37 |

The one-CPU latency targets do not apply to this report-only CPU limit.
Quota waits dominate several calls. Planning time can include those waits.
Player search remains the largest execution statement.

## Planning and execution

These are representative one-CPU traces for the first manager.
Each cell gives nested planning / execution in milliseconds.
They are instrumented calls, not latency samples or p95 estimates.

| Statement | Before fresh | After fresh | Before warm | After warm |
| --- | ---: | ---: | ---: | ---: |
| Roster averages and player JSON | 2.044 / 2.235 | 2.298 / 2.348 | 0.865 / 2.151 | 0 / 2.186 |
| Projection page | 5.350 / 6.818 | 5.888 / 7.551 | 4.382 / 7.443 | 0 / 7.169 |
| League pending count | 0.382 / 0.007 | 0.494 / 0.008 | 0.193 / 0.006 | 0 / 0.006 |
| Discarded trade-block roster | 1.087 / 2.469 | 0 / 0 | 0.926 / 2.060 | 0 / 0 |

The retained roster, projection, and count plans have zero warm planning calls in these traces.
The trade list does not invoke the discarded roster statement.
Player search still uses a custom plan for selective filters.
The projection helper previously replanned on each call because its SQL body did not inline.
Its PL/pgSQL body now retains the generic plan.

At quarter CPU, the largest traced planning waits are 78.08 ms in `locked_assets`,
86.46 ms in the projection query, and 76.54 ms in the pending trade count.
The largest league statement is the standings aggregation at 45.13 ms execution.
Trade-card aggregation reaches 82.76 ms execution.
Player-search aggregation reaches 288.00 ms execution, including its nested work.
These identify the remaining quarter-CPU delays. The raw traces retain every statement.

## Installed migration

This check opens new connections after applying the migration normally.
It does not substitute function definitions in the measurement transaction.
Each cell is the worst p95 across three managers, with five samples per manager.

| Function | One CPU fresh / warm ms | Quarter CPU fresh / warm ms |
| --- | ---: | ---: |
| view_roster | 16.25 / 2.62 | 92.31 / 2.81 |
| view_players | 41.14 / 20.47 | 195.84 / 104.25 |
| view_league | 4.80 / 0.50 | 50.99 / 78.53 |
| view_trades | 21.12 / 9.20 | 97.00 / 99.57 |

The container is throttled in 198 of 198 quarter-CPU periods, for 13.79 seconds.
It is throttled in 3 of 62 one-CPU periods, for 2.03 milliseconds.
These counters cover the whole container, including its psql client processes.
They confirm the large quarter-CPU spread comes with sustained quota waits.

[Full measurements](slow-screens-tables.md) give defaults for every manager and CPU limit.
[Generated results](slow-screens-results.json) include summaries of all 3,000 comparison samples,
240 installed samples, 96 fresh/warm statement captures, and the four kept rounds.
Raw plans remain in the mini's `slow-screens-evidence` directory.

## Verification

All 75 one-CPU variants and all twelve installed default calls pass their latency targets.
All 264 serialized JSON cases match across three managers and two days.
The live fixture has nine games. The off-day fixture has none.
Both corrupted-JSON controls reject exactly one altered response.
The SQL cost recipe passes sixty warm calls and both negative controls.

The full Node 22 Vitest run has 4,652 passes, 48 skips, and one release-note failure.
Moving the migration note into the current release section fixes that failure.
The final targeted run passes all 84 tests in the release, function-source, catalog, and attestation files.
Lint, application types, test types, canonical SQL sources, the live function catalog,
release attestations, and regenerated database types pass.
The type generator uses the private Docker network through a lane-local wrapper.
Generated types remove the retired stats default partition and include the backup's retained September log partition.

Seven SQL recipes pass:

- `view-screen-parity.sql`: 63 checks.
- `view-player-search-parity.sql`: 81 checks.
- `sleeper-projections.sql`: 61 checks, with its projection rows truncated in the rollback transaction.
- `fantasypros-projections.sql`.
- `game-calendar-corrections.sql`.
- `trade-veto-read-policy.sql`.
- `trade-offer-pagination.sql`.

These are isolated read measurements.
Production contention and production's two-second reads are not reproduced.
The game-night, stress, recovery, and full-night replay are outside this screen-read check.
No production latency or platform CPU-headroom gain is claimed.

## Changed functions

- `view_roster` uses a generic plan for its parameterized statements.
- `view_trades` requests only the returned card and block fields.
- `view_trade_details` supports `cardOnly`. Its default response is unchanged.
- `view_trade_block` supports `blockOnly`. Its default response is unchanged.
- `get_pending_trade_count` retains its plan in PL/pgSQL. `view_context` calls it for all four screens.
- `get_league_projection_rows` retains a generic PL/pgSQL plan. `view_players` calls it through `view_player_search`.

All six functions retain their signatures and security mode.
The migration replaces them in one transaction.
There are no table, index, cache, refresh worker, or delivery changes.

## Reproduce

Use the task's bundle procedure and copy the hashed backup into the lane's `backup` directory.
Keep the setup command running in a separate terminal.
Set these values in the private mini checkout:

```sh
export PATH=$HOME/pancake-local/tools:$PATH
export DOCKER_HOST=unix://$HOME/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock
export PERF_LAB_ON_MINI=1
export PERF_LAB_LANE=fable-l3d
export PERF_LAB_PROJECT=pt4bafablel3d
export PERF_LAB_PORT_PREFIX=624
export SCREEN_COST_EVIDENCE=slow-screens-evidence
node tests/db/screen-view-costs.mjs --setup
```

In the second terminal, use the same environment:

```sh
node tests/db/screen-view-costs.mjs --inventory
node tests/db/slow-screens.mjs --capture --label=final-1 --variants
node tests/db/slow-screens.mjs --trace --label=final-1 --managers
node tests/db/slow-screens.mjs --parity
node tests/db/slow-screens.mjs --parity --negative-control
node tests/db/slow-screens.mjs --sql --label=final-1
node tests/db/slow-screens.mjs --capture --cpus=0.25 --label=final-quarter --variants
node tests/db/slow-screens.mjs --trace --cpus=0.25 --label=final-quarter --managers
node tests/db/slow-screens.mjs --capture --installed --managers --label=installed-1
node tests/db/slow-screens.mjs --capture --installed --managers --cpus=0.25 --label=installed-quarter
node tests/db/slow-screens.mjs --report
```

`--variants` measures 75 cases across three managers.
`--managers` selects each manager's four default screen calls.
`--installed` measures the committed migration without applying function definitions inside the sample transaction.
The normal comparison substitutes release 2.8 definitions and rolls them back after each sample.
It removes the migration's transaction wrapper before nesting those definitions in the measurement transaction.
The SQL recipe measures fifteen warm calls per function across three managers.
Its delay and buffer controls must reject 70 ms and 3,000 buffers.
The one-CPU guard requires every measured screen variant below 150 ms fresh and 60 ms warm.

Do not run other database checks during measurement.
Create `../slow-screens-evidence/stop` when finished.
Setup stops only this private stack, restores its configuration, and removes copied backup files.

## Initial four-screen completion

The private stack is stopped and its cleanup receipt reports success.
No owned containers or copied backups remain.
The source configuration is restored.
No production service, deployment, push, or CI job was used.
Reuse the saved evidence until SQL, inputs, or the benchmark changes.

## Production addendum, 19:10 UTC

The lane also covers `view_player`, full `view_trade_block`, and `get_trade_revaluation_inputs`.
The worker fresh p95 limit is 300 ms. Screen limits remain 150 ms fresh and 60 ms warm.
The second pass compares against `75196628` and retains the first pass's measured changes.

| Round | Change | Evidence | Decision |
| --- | --- | --- | --- |
| 5 | Score the already selected player game lines without reading each statistic and league again | Historical warm median 16.14 → 10.90 ms. Buffers 2,191 → 1,371. Baseline spread 3.05 ms. 204 exact JSON cases pass. | Keep. 32% time and 37% buffer reductions exceed spread and 10%. |
| 6 | Return only roster inventory fields to the trade block | Fresh median 16.09 → 13.10 ms. Fresh buffers 7,548 → 6,301. Baseline time spread 2.60 ms. 204 exact JSON cases pass. | Keep. 19% time and 17% buffer reductions exceed spread and 10%. |
| 7 | Retain worker player-input and fingerprint statement plans | Warm median 9.73 → 6.53 ms. Baseline spread 1.96 ms. Fresh median 25.50 → 27.76 ms, within the 5.32 ms candidate spread. Warm buffers 890 → 969. 204 exact JSON cases pass. | Keep. 33% warm time reduction exceeds spread and 10%. The extra buffers remain below 10%; fresh calls remain below 300 ms. |
| 8 | Batch trade cards after one membership check and restrict every child read to the authorized page | Forty-card warm median 215.16 → 14.83 ms. Buffers 23,702 → 2,150. Baseline time spread 24.91 ms. 206 exact JSON cases and seventeen fixture checks pass. | Keep. 93% time and 91% buffer reductions exceed spread and 10%. |

A rollback-only forty-card fixture reproduces slow trade repeats after the initial fixes.
It takes 217–257 ms warm and 23,046–23,618 buffers at one CPU.
This fixture is included in the remaining trade work and parity checks.



### Addendum method and functions

`slow-screen-addendum.mjs` reuses the earlier fixture, EXPLAIN, fresh/warm, and nested-plan helpers.
It measures all seven entry points and a separate forty-card trade page.
The 103 cases include three managers, player sections, historical game lines, league tabs, player availability, and three four-asset trades.
The worker runs as `service_role` with a three-second statement timeout.
Open restored trades keep their original status during measurement.
The dense fixture clones restored cards inside the sample transaction and always rolls back.
It is a synthetic page-size check. It does not model the production action mix.

The changed addendum functions are:

- `view_player`, using the existing `projection_stat_fantasy_points` helper on selected lines.
- `view_roster` and `view_trade_block`, sharing the `inventoryOnly` path.
- `private.trade_value_player_inputs` and `private.trade_revaluation_input_version`, retaining generic plans.
- `get_trade_cards`, checking membership and the visibility of each requested trade before batching child rows.
- `view_trades`, using the batch helper and skipping it for an empty page.

`get_trade_cards` supports at most 100 IDs and preserves order, repeated IDs, missing rows, and hidden rows.
Only authenticated and service roles can execute it.
The SQL fixture compares it against the existing card response for three managers.
It covers quoted estimates, unavailable estimates, pending and completed trades, accepted observers, vetoes, foreign trades, empty pages, and request limits.
Scoring checks cover decimal weights, zero weights, null statistics, DNPs, and double/triple bonuses.
The timing guard rejects an intentionally delayed read.

### Repeat the addendum

Use the same private project, port block, and setup procedure.
Set `SCREEN_COST_EVIDENCE=slow-screen-addendum-evidence` before starting setup.
After the ready marker, run these commands with the same environment:

```sh
node tests/db/slow-screen-addendum.mjs --inventory
node tests/db/slow-screen-addendum.mjs --sql --label=final-1
node tests/db/slow-screen-addendum.mjs --parity --label=final-1 --dense
node tests/db/slow-screen-addendum.mjs --capture --label=final-1 --variants --dense
node tests/db/slow-screen-addendum.mjs --trace --label=final-1 --dense
node tests/db/slow-screen-addendum.mjs --capture --label=final-quarter --variants --dense --cpus=0.25
node tests/db/slow-screen-addendum.mjs --trace --label=final-quarter --dense --cpus=0.25
node tests/db/slow-screen-addendum.mjs --capture --installed --label=installed-1 --dense
node tests/db/slow-screen-addendum.mjs --capture --installed --label=installed-quarter --dense --cpus=0.25
node tests/db/slow-screen-addendum.mjs --report --dense
```

Create `../slow-screen-addendum-evidence/stop` after verification.
Keep the statement traces and sample files in that evidence folder.

### Final addendum results

All 103 variants pass at one CPU. The largest screen fresh/warm p95 is 47.71 / 27.16 ms.
Worker fresh p95 is 28.84 ms, below 300 ms. Its warm p95 is 8.77 ms.
The forty-card page has 25.37 ms fresh and 15.17 ms warm p95.

The isolated addendum comparison uses `75196628`.
It contains 4,120 latency samples and 440 installed-migration samples.
All installed calls also pass. Definitions are not substituted in those samples.
There are 176 default statement captures and 24 historical-player captures.

The combined release comparison restores all changed definitions from `628c7def`.
It adds 880 samples across both CPU limits. The table below shows default calls and the dense page.
Each value is the largest p95 across three managers, with five samples per case.

| CPU | Function | Before fresh ms | After fresh ms | Before warm ms | After warm ms | Before / after warm buffers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | view_roster | 13.87 | 12.84 | 4.18 | 2.70 | 504 / 399 |
| 1 | view_players | 42.10 | 43.62 | 38.64 | 20.06 | 2165 / 2052 |
| 1 | view_league | 3.28 | 4.14 | 0.65 | 0.45 | 49 / 40 |
| 1 | view_trades | 34.67 | 15.62 | 18.76 | 5.76 | 1683 / 387 |
| 1 | view_player | 26.51 | 28.29 | 13.88 | 7.48 | 1023 / 821 |
| 1 | view_trade_block | 15.43 | 12.84 | 4.92 | 2.44 | 530 / 368 |
| 1 | get_trade_revaluation_inputs | 33.50 | 27.24 | 16.69 | 6.91 | 992 / 1007 |
| 1 | 40-card trades | 558.82 | 24.11 | 515.52 | 15.22 | 76126 / 2170 |
| 0.25 | view_roster | 92.62 | 94.01 | 81.52 | 3.10 | 539 / 434 |
| 0.25 | view_players | 281.87 | 287.83 | 202.83 | 96.51 | 2206 / 2093 |
| 0.25 | view_league | 80.62 | 4.24 | 0.70 | 77.06 | 55 / 46 |
| 0.25 | view_trades | 186.49 | 95.05 | 95.26 | 6.57 | 1854 / 539 |
| 0.25 | view_player | 180.54 | 183.24 | 90.70 | 83.14 | 1064 / 862 |
| 0.25 | view_trade_block | 91.95 | 92.53 | 81.25 | 77.91 | 571 / 390 |
| 0.25 | get_trade_revaluation_inputs | 101.61 | 182.81 | 100.71 | 83.19 | 992 / 1007 |
| 0.25 | 40-card trades | 2378.67 | 101.32 | 2189.63 | 94.39 | 72718 / 2123 |

Both comparisons preserve serialized JSON for all 103 cases on both dates.
That is 412 exact comparisons with four corrupted-response controls.
The live fixture has nine games. The off-day fixture has none.

Quarter-CPU results retain quota-phase spread, including on unchanged screens.
The screen limits apply at one CPU. Quarter CPU is reported separately.
In the default nested traces, the largest remaining player projection call is 90.10 ms.
Roster average planning reaches 76.33 ms inside `view_player`; its one-CPU warm plan is cached.
The full trade-block roster aggregation reaches 78.63 ms execution.
Worker authorization planning reaches 36.96 ms and input assembly reaches 99.40 ms execution.
The trade response assembly reaches 93.90 ms, including child work.
Those are instrumented statement totals at quarter CPU. Parent and child times overlap.
They identify the remaining delays without adding their totals together.

[Complete tables](slow-screen-addendum-tables.md) include the broader variant comparison.
[Generated addendum results](slow-screen-addendum-results.json) include distributions, installed calls, planning/execution splits, and historical traces.

### Addendum verification

The new SQL recipe passes seventeen checks and its timing guards.
It covers three manager identities, quotes, visibility, bounds, scoring, and a deliberate delay.
The first guarded call allows 150 ms for screens and 300 ms for the service worker.
Following calls allow 60 ms. The worker also retains its three-second statement timeout.

The relevant existing SQL recipes pass:

- `trade-revaluation-fast.sql`: 24 checks.
- `trade-revaluation-scope.sql`: 33 checks.
- `trade-veto-read-policy.sql`.
- `trade-offer-pagination.sql`.
- `view-screen-parity.sql`: 63 checks.

The targeted Vitest run passes all 118 tests in six files.
It covers function sources, security catalog, attestations, release order, and trade workers.
Lint, application types, test types, live catalog checks, release attestations, and generated types pass.
The function catalog, both attestations, and database types are regenerated through their generators.
The full suite is not rerun for the addendum, as requested. No push or CI run is performed.

The release comparison uses the combined SQL saved as `release-candidate.sql` in the private evidence folder.
Run captures with `--base=628c7def --candidate=../slow-screen-addendum-evidence/release-candidate.sql --dense`.
Use labels `release-1` and `release-quarter`, with `--cpus=0.25` for the latter.
Add `--parity --label=release-1 --dense` for release JSON checks.
Historical traces use `--trace --historical` with labels `historical-1` and `historical-quarter`.

No production latency or full-platform CPU-headroom gain is claimed.
The forty-card execution bottleneck is reproduced and removed on the private benchmark.

### Addendum completion

The private stack is stopped. Its cleanup receipt reports success with no cleanup errors.
The owned project has no remaining containers. Copied backup files and compressed copies are removed.
The source configuration is restored. No production service, push, deployment, or CI job is used.
Reuse these measurements until the SQL, inputs, or harness changes.
