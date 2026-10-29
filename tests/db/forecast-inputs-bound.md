# Forecast input bound

The repair keeps forecast outputs unchanged and bounds history lookups.
The index lives on `public.player_game_stats` and reaches every current and future partition.
The game check uses the unique game ID before the history query reaches its 30-row limit.

## Evidence

The private mini restores the supplied backup at migration `20261029000800` and applies main through `20261210000300`.
It contains 245,097 player game rows, 2,618 players, 8,430 games, and 70 stats partitions.
Docker limits Postgres to one CPU throughout the measurements.
The tests use the three reported matchups and two fixed clocks: October 27 and October 28 at 23:00 UTC.
The second clock advances one real scheduled game into progress inside a rollback transaction.
Both custom plans and generic plans run against the same data.
Cold repetitions truncate the private caches; warm repetitions reuse their rows.

Every measured call uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
The first repetition also records every nested statement through `auto_explain` with analysis, buffers, and timing enabled.
Later repetitions retain the outer measurement without nested logging.
The timing guard checks each matchup, clock, plan mode, and call type separately.
It rejects p95 values of 300 ms or greater and any call or statement of 1,000 ms or greater.

The initial history plan reaches all 70 partitions and repeatedly compares each player's rows against materialized game rows.
One measured plan removes 167,113 game join candidates per player across 50 players.
That history statement takes 632.421 ms at its peak.
Refreshing statistics hides that plan choice, so the repair makes the game lookup explicit.
The replacement uses ordered partition indexes, a merge append, and game primary-key probes.
It preserves the date, season, participation, final status, regular-season, and tie-order filters.

The backup reproduces the slow plan and the failed 300 ms guard.
An isolated call does not reach the production three-second timeout on this mini.
Production remains untouched.

## Measurements

All 5,880 final calls finish below 300 ms.
The worst p95 is 70.897 ms; the maximum is 238.297 ms.
The final before and after runs each use 30 repetitions per case.
Fresh statistics also keep the original implementation below the target.
The initial restored-state run exposes the unsafe history plan before that statistics refresh.

### Nested statements

Each cell shows peak milliseconds and peak shared buffer hits/reads.
Nested plans come from the first repetition of each matchup, clock, and plan mode.
The initial column records the original restored-state plans.

| Statement | Initial ms; H/R | Before, fresh stats ms; H/R | After ms; H/R |
| --- | ---: | ---: | ---: |
| History rebuild | 632.421; 11,754/1,198 | 144.249; 19,315/0 | 136.637; 21,336/0 |
| Projection assembly | 33.746; 6,051/158 | 65.377; 4,710/0 | 73.891; 4,710/0 |
| get_league_projection_rows | 28.914; 5,509/143 | 59.532; 3,918/0 | 65.843; 3,919/0 |
| Season points refresh | 10.711; 41,317/32 | 10.090; 567/0 | 35.875; 567/0 |
| Prepared context and season averages | 18.847; 5,946/119 | 16.584; 2,843/0 | 13.879; 2,843/0 |
| read_matchup_forecast_context | 5.825; 4,322/13 | 3.505; 831/0 | 2.390; 831/0 |
| matchup_forecast_inputs_ready | 5.172; 31,529/0 | 1.028; 399/0 | 0.969; 399/0 |
| Projection expiry | 2.482; 437/90 | 2.397; 351/0 | 1.471; 351/0 |
| Remaining game dates | 1.448; 29/0 | 1.903; 25/0 | 2.170; 25/0 |
| Fantasy points calculation | 0.120; 0/0 | 0.301; 0/0 | 0.672; 0/0 |
| Foreign key: players | 0.065; 5/0 | 0.039; 5/0 | 0.671; 5/0 |
| Projection cache write | 0.308; 41/1 | 0.436; 15/1 | 0.366; 15/1 |
| Roster IDs and hash | 0.066; 7/0 | 0.106; 5/0 | 0.184; 5/0 |
| Missing history lookup | 0.160; 754/0 | 0.101; 4/0 | 0.042; 4/0 |
| Regular-season game ID | 0.060; 0/0 | 0.060; 0/0 | 0.118; 0/0 |
| Matchup settings | 0.068; 10/0 | 0.117; 10/0 | 0.080; 10/0 |
| Projection revision | 0.003; 2/0 | 0.017; 1/0 | 0.069; 1/0 |
| Current projection lookup | 0.040; 4/0 | 0.072; 2/0 | 0.008; 2/0 |
| Unprepared dates | 0.028; 5/0 | 0.047; 2/0 | 0.037; 2/0 |
| Foreign key: leagues | 0.014; 3/0 | 0.054; 3/0 | 0.032; 3/0 |
| History revision | 0.026; 2/2 | 0.025; 1/0 | 0.016; 1/0 |
| Foreign key: matchups | 0.015; 3/0 | 0.016; 3/0 | 0.010; 3/0 |
| Expired date cleanup | 0.012; 5/0 | 0.021; 2/0 | 0.008; 2/0 |

### Calls

Each row reports the worst result across the two clocks and both plan modes.
H/R means shared buffer hits/reads.

| Matchup | Call | Before p95 ms | After p95 ms | After max ms | Before H/R | After H/R |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 07ad4dd3 | context | 25.485 | 22.172 | 26.359 | 3,942/0 | 4,325/0 |
| 07ad4dd3 | date_cold:2026-11-02 | 40.555 | 31.788 | 67.373 | 5,185/1 | 5,184/1 |
| 07ad4dd3 | date_cold:2026-11-04 | 45.177 | 27.109 | 62.325 | 4,294/0 | 4,294/0 |
| 07ad4dd3 | date_cold:2026-11-05 | 38.632 | 25.788 | 53.644 | 4,293/0 | 4,293/0 |
| 07ad4dd3 | date_cold:2026-11-06 | 35.617 | 28.232 | 61.550 | 4,294/0 | 4,294/0 |
| 07ad4dd3 | date_cold:2026-11-07 | 38.185 | 26.128 | 58.225 | 4,267/0 | 4,267/0 |
| 07ad4dd3 | date_cold:2026-11-08 | 33.793 | 26.095 | 58.633 | 4,267/0 | 4,267/0 |
| 07ad4dd3 | date_warm:2026-11-02 | 2.649 | 0.752 | 1.719 | 31/0 | 31/0 |
| 07ad4dd3 | date_warm:2026-11-04 | 0.697 | 0.683 | 1.703 | 31/0 | 31/0 |
| 07ad4dd3 | date_warm:2026-11-05 | 0.708 | 1.105 | 1.774 | 31/0 | 31/0 |
| 07ad4dd3 | date_warm:2026-11-06 | 0.684 | 0.772 | 1.902 | 31/0 | 31/0 |
| 07ad4dd3 | date_warm:2026-11-07 | 0.943 | 0.697 | 1.997 | 31/0 | 31/0 |
| 07ad4dd3 | date_warm:2026-11-08 | 0.852 | 1.137 | 1.724 | 31/0 | 31/0 |
| 07ad4dd3 | prepare_cold | 84.476 | 70.897 | 238.297 | 36,009/4 | 39,593/4 |
| 07ad4dd3 | prepare_warm | 1.537 | 1.480 | 2.591 | 215/0 | 215/0 |
| 07ad4dd3 | season_changed | 5.336 | 4.222 | 8.414 | 1,117/0 | 1,117/0 |
| ccb35830 | context | 23.951 | 22.072 | 25.828 | 2,870/0 | 2,870/0 |
| ccb35830 | date_cold:2026-11-09 | 31.580 | 27.141 | 52.371 | 4,346/1 | 4,346/1 |
| ccb35830 | date_cold:2026-11-10 | 35.470 | 24.566 | 51.912 | 4,312/0 | 4,312/0 |
| ccb35830 | date_cold:2026-11-11 | 33.348 | 26.179 | 49.108 | 4,284/0 | 4,284/0 |
| ccb35830 | date_cold:2026-11-12 | 46.831 | 29.094 | 50.780 | 4,285/0 | 4,285/0 |
| ccb35830 | date_cold:2026-11-13 | 36.542 | 27.239 | 54.315 | 4,257/0 | 4,257/0 |
| ccb35830 | date_cold:2026-11-14 | 31.750 | 23.373 | 54.882 | 4,257/0 | 4,257/0 |
| ccb35830 | date_cold:2026-11-15 | 46.825 | 21.081 | 79.627 | 4,232/0 | 4,232/0 |
| ccb35830 | date_warm:2026-11-09 | 0.979 | 0.968 | 1.635 | 30/0 | 30/0 |
| ccb35830 | date_warm:2026-11-10 | 1.203 | 0.778 | 1.672 | 30/0 | 30/0 |
| ccb35830 | date_warm:2026-11-11 | 0.968 | 0.674 | 1.545 | 30/0 | 30/0 |
| ccb35830 | date_warm:2026-11-12 | 0.914 | 0.709 | 1.743 | 30/0 | 30/0 |
| ccb35830 | date_warm:2026-11-13 | 0.921 | 0.828 | 1.514 | 30/0 | 30/0 |
| ccb35830 | date_warm:2026-11-14 | 1.297 | 1.145 | 1.587 | 30/0 | 30/0 |
| ccb35830 | date_warm:2026-11-15 | 0.864 | 0.895 | 1.590 | 30/0 | 30/0 |
| ccb35830 | prepare_cold | 61.935 | 54.073 | 111.945 | 20,715/4 | 21,633/4 |
| ccb35830 | prepare_warm | 2.261 | 1.479 | 2.482 | 217/0 | 217/0 |
| ccb35830 | season_changed | 6.926 | 6.832 | 8.023 | 1,117/0 | 1,117/0 |
| e47fcb99 | context | 32.333 | 20.013 | 22.291 | 2,792/0 | 2,794/0 |
| e47fcb99 | date_cold:2026-10-27 | 37.357 | 25.448 | 55.078 | 4,386/1 | 4,388/1 |
| e47fcb99 | date_cold:2026-10-28 | 56.974 | 28.317 | 56.093 | 4,379/1 | 4,379/1 |
| e47fcb99 | date_cold:2026-10-29 | 30.478 | 33.386 | 63.181 | 4,320/0 | 4,320/0 |
| e47fcb99 | date_cold:2026-10-30 | 42.274 | 28.638 | 61.549 | 4,320/0 | 4,320/0 |
| e47fcb99 | date_cold:2026-10-31 | 38.728 | 26.631 | 59.618 | 4,267/0 | 4,267/0 |
| e47fcb99 | date_cold:2026-11-01 | 37.015 | 25.915 | 60.696 | 4,267/0 | 4,267/0 |
| e47fcb99 | date_warm:2026-10-27 | 1.545 | 1.377 | 2.879 | 31/0 | 32/0 |
| e47fcb99 | date_warm:2026-10-28 | 1.515 | 0.937 | 1.391 | 32/0 | 32/0 |
| e47fcb99 | date_warm:2026-10-29 | 1.495 | 1.082 | 1.466 | 32/0 | 32/0 |
| e47fcb99 | date_warm:2026-10-30 | 1.429 | 0.712 | 1.353 | 32/0 | 32/0 |
| e47fcb99 | date_warm:2026-10-31 | 1.358 | 0.760 | 1.254 | 32/0 | 32/0 |
| e47fcb99 | date_warm:2026-11-01 | 1.316 | 0.756 | 1.483 | 32/0 | 32/0 |
| e47fcb99 | prepare_cold | 92.126 | 48.782 | 108.970 | 20,445/4 | 22,289/4 |
| e47fcb99 | prepare_warm | 2.656 | 1.563 | 2.618 | 224/0 | 224/0 |
| e47fcb99 | season_changed | 7.477 | 5.425 | 8.215 | 1,163/0 | 1,163/0 |

### Controls

The original restored-state samples fail the same JavaScript timing guard used for the final run.
The six unit controls exercise the 300 ms boundary and the single-statement limit.
A separate stale-statistics run passes 980 calls, with a maximum of 132.724 ms.
Its 234 output pairs also match exactly.
The first long-transaction stress run passes another 5,880 calls, with p95 at most 139.220 ms and maximum 185.675 ms.

## Correctness

The benchmark compares the complete context and all projection rows as exact JSON text.
It covers daily, weekly average, and weekly total projections on every remaining matchup date.
The main comparison contains 234 exact output pairs.
The regression recipe also checks new partition inheritance, unchanged cache rows, source xmin updates, and service-role calls under three seconds.
Existing history tests cover ties, old seasons, non-regular games, did-not-play rows, corrections, and score rules.

Season refresh remains limited to roster players.
Changing one totals row leaves other players' prepared season rows unchanged.
Repeated unchanged calls preserve history, projection, and season cache rows.
Projection assembly and context reads stay within the requested bound without source changes.

## Repeat

Use the restored private mini stack and its scoped local connection.
Keep the database container at one CPU.
Save the original function from the stated base before running the comparison.
The original mode restores that function and removes the new index inside each rollback transaction.

```sh
export SUPABASE_DB_URL=postgresql://supabase_admin:postgres@127.0.0.1:61722/postgres
export PANCAKE_TEST_DB_PORT=61722
docker update --cpus=1 supabase_db_pt4bafablefi
git show 2adcfa9a:supabase/sql/functions/by-name/public/prepare_matchup_forecast_inputs.sql > ../prepare-before.sql
node tests/db/forecast-inputs-bound.mjs --phase before --samples 30 --original ../prepare-before.sql --output ../before.json
node tests/db/forecast-inputs-bound.mjs --phase after --samples 30 --baseline ../before.json --output ../after.json
psql "$SUPABASE_DB_URL" -XqAtv ON_ERROR_STOP=1 -f tests/db/forecast-inputs-bound-regression.sql
```

The SQL recipe rolls back the clock, game state, caches, function definitions, and test partitions.
The runner accepts only loopback port 61722 and verifies the one-CPU container setting.
The unit controls prove that the guard rejects both a slow percentile and a single slow statement.

## Scope

The only changed function source is `public.prepare_matchup_forecast_inputs`.
No other called function source changes.
The migration is `20261211000300_forecast_inputs_bound.sql`.
The existing generators produce the catalog and migration attestations.

## Checks and handoff

The six database recipes pass:

- `forecast-inputs-bound-regression.sql`
- `matchup-forecast-history.sql`
- `matchup-forecast-cache.sql`
- `matchup-forecast-cache-parity.sql`
- `matchup-forecast-season-average.sql`
- `forecast-input-write-gate.sql`

`npm run lint:all`, `npm run typecheck`, and `npm run typecheck:tests` pass.
The full Vitest suite passes on Node 22: 4,590 tests pass and 48 are skipped.
Function source parity, the live function catalog, and generated migration attestations pass.
The release instructions include this migration in `supabase/RELEASE-DB.md`.

| Changed file | Purpose |
| --- | --- |
| `supabase/sql/functions/by-name/public/prepare_matchup_forecast_inputs.sql` | Bounded game lookup. |
| `supabase/migrations/20261211000300_forecast_inputs_bound.sql` | Parent index and matching function. |
| `tests/db/forecast-inputs-bound.sql` | Timing and parity recipe. |
| `tests/db/forecast-inputs-bound.mjs` | Local target guard, CPU guard, comparison, and statement capture. |
| `tests/db/forecast-inputs-bound-regression.sql` | Inheritance, cache reuse, source revisions, and service-role checks. |
| `tests/forecast-inputs-bound.test.ts` | Timing guard controls. |
| `tests/db/forecast-inputs-bound.md` | Results and repeat commands. |
| `tests/e2e/release-history-attestations.json` | Generated migration attestation. |
| `tests/e2e/db-security-catalog-attestations.json` | Generated catalog attestation. |
| `supabase/RELEASE-DB.md` | Migration entry and release order. |

The function catalog generator produces no manifest change.
The private stack stops after verification, and the transferred backup files are removed.
Keep the completed timing, parity, inheritance, and cache tests as evidence.
The release entry records the migration's required order.
