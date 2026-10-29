# L4b forecast cost

The baseline is `ec739102`, release 2.9.1.
All database work uses the private mini project `pt4bafablefo` and ports `629xx`.
Postgres has a quarter CPU and 1 GiB of memory.
The supplied backup is restored at its recorded schema baseline and migrated to this branch.
Cron is disabled. The database rejects external HTTP.
Production is never contacted.

## Cause

League hints queue every eligible matchup for lineup, roster, score, game, stat, player statistics, and resource changes.
Resource changes include search cache refreshes and trade values.
Search cache refreshes also advance the projection input revision.
The worker computes every claim without comparing its forecast inputs.
An invalid projection cache adds one preparation call for each remaining game date.
Expiry adds another unconditional recomputation path.

These paths explain repeated preparation and publication while court inputs stay fixed.
The production counts alone do not identify the exact event mix.
One Edge invocation claims at most ten matchups.
The reported aggregate counts therefore span repeated invocations and requeues.
They cannot be attributed to three single executions from this evidence alone.
The restored backup has fifteen eligible matchups across three weeks.

## Input gate

Each queue row keeps the pending, claimed, and completed input fingerprints.
The fingerprint covers both rosters, player availability, saved lineups, automatic lineup settings, slot templates, scoring rules, matchup points and state, projection source revision, history revision, the week calendar, and the matchup's stat lines.
Live clocks are recorded with each changed input tick.
A clock-only poll leaves the computation key unchanged.
Projection freshness, tipoff, and the Eastern date are input boundaries.

Queue writes compare the computation key before dirtying a matchup.
Repeated hints leave the revision and completed cache alone.
Completion keeps the existing claim token and revision fences.
An unchanged expiry renews validity without preparing, reading context, or computing.

Projection source revisions advance for changed provider rows and successful source selections.
Search cache refreshes and trade value publications do not advance them.
Current live averages do not pulse forecasts for future weeks.
Fallback averages are read when a projection/history revision or another forecast input requires computation.
Historical revisions change for relevant final game history, including corrections.

Stat ingestion uses the existing score publication path.
Matchup score publication queues the updated forecast.
The coalesced score hint covers changed lines whose fantasy points stay equal.
Broad stat, game, and resource hints do not start an extra preparation before score publication.
Game and projection source invalidation queue their meaningful changes directly.

## Rounds

Each round uses five interleaved baseline and candidate runs.
The order alternates each round.
Measurements use the screen cost harness's rollback transactions and `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)` method.
The fixed clocks and exact context checks come from `forecast-inputs-bound`.

| Round | Change | Before | After | Decision |
| --- | --- | --- | --- | --- |
| 1 | Prepare all missing dates in one call. Share roster, settings, revisions, dates, and expiry. | 43 cold calls across six matchup/clock cases. | 6 cold calls. | Keep the 86% call reduction. DB time is within noise. |
| 2 | Gate queued work by matchup inputs. Separate source revisions from search refreshes. | Repeated unchanged work. | Zero idle forecasts and one forecast per changed live tick, plus tipoff transitions. | Keep. Both DB gains exceed noise; live parity and latency pass. |

Round 1 covers the three reported matchups at October 27, 20:30 UTC and October 28, 23:00 UTC.
The latter advances scheduled games into progress inside the rollback transaction.
All 120 cold and warm samples pass exact context and computed forecast comparison across 12 distinct cases.
Mean total preparation time per six cold and six warm cases is 4,436 ms before and 4,306 ms after.
The 3% difference is below the 10% noise floor and the observed spread.
No CPU improvement is attributed to batching.

Round 2 compares against `fa04b134`, which already contains batching.
It deliberately calls the queue after every event to exercise the fingerprint under repeated invalidations.
Each pair replays an idle business hour at October 27, 20:30 UTC and a 30-minute live window at October 28, 23:00 UTC.
Time advances without wall-clock sleeps.
A priming sweep prepares every eligible matchup before measurement.
Claims use the worker's limit of ten and drain the eligible queue.
Live ticks arrive every thirty business seconds; every other tick changes a stat line and publishes its matchup score.
Clock-only ticks still advance both clock fields.

| Round 2 metric | Before | After | Gain |
| --- | ---: | ---: | ---: |
| Idle forecast DB ms/hour | 166,910 | 5,926 | 96.5% |
| Live forecast DB ms/hour | 303,563 | 16,203 | 94.7% |
| Idle context/completion calls/hour, each | 900 | 0 | 100% |
| Live context/completion calls/hour, each | 1,800 | 70 | 96.1% |
| Mean matched live p95, ms | 3,187 | 879 | 72.4% |

The idle baseline spread is 26,960 ms/hour; the candidate spread is 415.
The live spreads are 20,676 and 6,095 ms/hour.
Both gains exceed the larger spread and ten percent of baseline.
All 175 candidate live forecasts match the baseline output hashes.
Every paired live p95 improves.
Each live window publishes thirty changed stat ticks and five tipoff transitions.
The [round report](../tests/db/forecast-costs-gate.json) records all five pairs.

The final replay uses ordinary hint and scheduler paths against release 2.9.1.
Its idle hour starts October 29 at 20:30 UTC.
Twenty-seven resource pulses include three search refreshes; the other pulses change only the league resource hint.
This models nine queue pulses and one projection-cache epoch per twenty minutes.
Fifteen eligible matchups yield 135 context/completion calls and 85 extra date preparations per period.
Together they reproduce the reported 220 preparations and 135 completions.
This is a controlled reproduction of the aggregate pattern, not a claim about the exact production event timing.

## Correctness

All eighty backup matchups pass exact context and computed forecast JSON comparison against release 2.9.1 on both dates.
The off day is November 3 at 20:30 UTC, with zero scheduled games and zero live games.
The live day is October 28 at 23:00 UTC, with four live games from a twelve-game slate.
The [parity report](../tests/db/forecast-costs-parity.json) records all 160 pairs and their hashes.

The fingerprint recipe passes 28 checks.
It covers unchanged hints, unrelated lineups, opponent lineups, clock-only polls, changed and identical stat lines, score publication, future-week isolation, stale claims, provider publication and corrections, failed runs, expiry, after-midnight live games, final status, and access control.
The eight existing forecast SQL recipes pass.
The concurrency recipe passes blocking, parallel publication, stale-result rejection, token fencing, retry, corruption, and outsider checks.
Ten Edge unit tests pass, including the batched backend and legacy date-list paths.

Function-source parity, live catalog parity, database types, migration attestations, lint, and typechecks pass.
The database type check uses the private Docker network through the owned CLI wrapper.
The single full Vitest run passes 4,709 tests; 48 are skipped.
It uses Node 22, two workers, and a 1 GiB heap limit per process.
The eight updated benchmark controls also pass after resume support is added.

## Final release 2.9.1 comparison

All five interleaved pairs pass the noise, live parity, and matched latency guards.
The [final report](../tests/db/forecast-costs-final.json) records each pair and both function-source digests.
All rates below are per business hour.
DB times are means of the five runs on this private bench.
They are not new production measurements.

| Metric | Idle before | Idle after | Live before | Live after |
| --- | ---: | ---: | ---: | ---: |
| Preparation calls, including date calls | 660 | 0 | 12,600 | 70 |
| Prepared context calls | 405 | 0 | 1,800 | 70 |
| Completion calls | 405 | 0 | 1,800 | 70 |
| Forecast path DB ms | 17,950 | 71 | 360,429 | 3,491 |
| All measured top-level DB ms | 18,422 | 90 | 366,711 | 7,040 |
| Forecast path buffers hit + read | 1,295,378 | 43,038 | 21,857,577 | 370,627 |

Forecast path DB time falls 99.6% idle and 99.0% live.
The total measured DB reductions are 99.5% and 98.1%.
The forecast path includes invalidation, enqueue, claim, preparation, context, and completion.
The total also includes the replay's source writes and measurement statements from `pg_stat_statements` deltas.
The candidate still makes empty claim probes in this harness; normal scheduling need not invoke a forecast worker for clean inputs.

The idle baseline spread is 4,645 ms/hour and the candidate spread is 97.
The live spreads are 158,938 and 2,304 ms/hour.
The reductions exceed both the larger spread and the ten-percent floor.
Mean matched live p95 improves from 6,365 ms to 891 ms.
Every individual pair improves and all 175 live forecast hashes match.
Latency includes source writes, queueing, preparation, context, JavaScript computation, and completion in the replay driver.
It does not measure the wall-clock cron wait.

The live workload refreshes search state every poll and changes one matchup's stat line on alternate polls.
It exercises unchanged polls and isolation from other matchups and future weeks.
This is an isolated forecast replay. It does not establish whole-app game-night or stress CPU headroom.

Two private container restarts interrupted final comparison attempts.
The container records no OOM events.
Only complete windows are retained in checkpoints; interrupted windows are discarded.
The saved cases are checked against the committed SQL sources and parity digests before resuming.
Each resumed case repeats its full priming sweep and measurement window.
Twenty unique complete cases make the final five pairs.
The cause of the container restarts is not established.
The final live catalog and migration-attestation checks pass after the replay.
The private stack is stopped with no cleanup errors.
The transferred backup copies are removed.

## Changed functions

- `public.prepare_matchup_forecast_inputs(uuid,date)`
- `private.matchup_forecast_input_fingerprint(uuid)`
- `private.queue_matchup_forecasts(uuid,uuid)`
- `private.queue_changed_matchup_forecasts()`
- `private.enqueue_matchup_forecasts(timestamptz)`
- `private.invalidate_forecast_inputs()`
- `public.claim_matchup_forecasts(integer)`
- `public.complete_matchup_forecast(uuid,bigint,uuid,jsonb,timestamptz)`

The migration is `20261214001500_matchup_forecast_inputs.sql`.
Function sources are edited first and copied into the migration.
Generated attestations come only from the repository generators.

## Repeat

Use Node 22 in the owned mini checkout.
Set `PERF_LAB_ON_MINI=1`, `PERF_LAB_LANE=fable-l4b`, `PERF_LAB_PROJECT=pt4bafablefo`, and `PERF_LAB_PORT_PREFIX=629`.
Use the documented mini Docker socket.
Copy only the supplied schema and data into the owned lane's `backup` directory before starting.

```sh
node tests/db/forecast-costs-stack.mjs
node --experimental-strip-types tests/db/forecast-costs.mjs --samples=5
node --experimental-strip-types tests/db/forecast-costs.mjs --round=parity --base=ec739102 --output=forecast-parity.json
node --experimental-strip-types tests/db/forecast-costs.mjs --round=replay --base=ec739102 --samples=5 --output=forecast-final.json
```

The stack runner writes `forecast-ready` after restore, migrations, and resource limits.
Run measurements only after that file appears.
The report is stored beside the private checkout.
Use the same replay command with `--resume` after an interruption.
The checkpoint requires identical function digests and protocol and rejects duplicate cases.
The runner creates `bin/supabase` beside the checkout to select its Docker network.
Use that directory first on `PATH` and unset `SUPABASE_DB_URL` when running `npm run check:database-types`.
Create `forecast-stop` in the owned lane to stop and remove the stack.
The runner removes the transferred backup after restoration.
