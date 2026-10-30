# Forecast wakeups

The 12:40 UTC production read reports 82 overdue matchup requests and three blocked dirty forecasts. Ship `f765a6d8` with migrations `20261214005406_forecast_input_recovery.sql` and `20261214005407_forecast_ready_priority.sql`. The earlier efficiency result alone does not establish input-worker progress.

Baseline: accepted pipeline head `505d7734`.
The private production-shaped restore has 15 dirty forecasts blocked by pending input scopes after migration. Draining the scopes and running the real preparation and forecast model completes all 15. No error or expiry loop remains in that settled restore.

Dispatcher admission checks dirty, due, and claim age. The worker also checks pending input scopes. The missing admission condition lets the dispatcher launch a worker that cannot claim anything. A held input backlog reproduces 58 empty forecast invocations across 60 simulated minute ticks. This establishes the defect locally. Production queue state is needed to attribute every reported production wakeup to it.

The day gate is frozen before the fix. It compares all fields returned by `get_matchup_forecast` at 84 checkpoints across a day. The scenarios include a settled morning, lineup changes, injury changes, a projection publication, schedule changes, tipoff, a 30-player live snapshot, final status, midnight, and the six-hour expiry. A second scenario holds an input scope for the idle hour, then releases it. The real forecast model runs in Node. PostgreSQL clock and UUID inputs are deterministic. No returned field is removed or normalized.

A/A passes. Changing one returned stale flag fails the gate. The SQL admission recipe also fails on baseline because it launches blocked work. The private Docker project uses two CPUs, 1 GiB memory, 224 MB shared buffers, and 384 MB effective cache. Other lanes run concurrently. No shared measurement lock is used.

The recorded slow REST rows have parameters `p_league_id, p_member_id, p_params`. That exact parameter list matches 26 `view_*` functions and no forecast RPC. The snapshots truncate before the function call, so they cannot distinguish the three function names. No view function is changed.

The fix adds the claim RPC's pending-input predicate to both admission copies. A completed input chunk enqueues computation as soon as its dirty scope is runnable. That retains the existing minute key, coalescing, retries, lease age, and worker caps. Six admission checks pass, including the immediate input-ready wakeup and lease recovery. The existing fingerprint, write gates, cache parity, chunk races, watchdog, and live shed tests pass. Both 84-checkpoint day comparisons pass. No forecast formula, expiry duration, returned metadata, or worker code changed.

Production code: `f765a6d8`, migration `20261214005405_forecast_claimable_wakeups.sql`.
Changed private helpers: `enqueue_matchup_forecasts`, `enqueue_scheduled_work`, and `complete_forecast_input_chunk`.
No shared TypeScript helper changed.

Five independent hourly A/B pairs alternate which arm runs first. Every blocked-input baseline creates 58 forecast jobs and 58 forecast invocations. Every candidate creates zero. Baseline spread is zero; the noise floor is 10%, or 5.8 jobs. Both arms perform the same 75 legitimate forecast computations over each simulated day. A settled morning creates zero forecast jobs in both arms. The day gate passes all 504 checkpoint comparisons across the five blocked pairs and the settled pair.

Each dispatcher measurement below uses five interleaved pairs with a new PostgreSQL backend for each arm. Statements include nested `pg_stat_statements` calls and the outer call. Rows are transaction writes. Functions count executed user functions. Relations count application relations and indexes held after the call. Those counts describe the catalog footprint; direct syscache misses are not measured.

| Scenario | Forecast jobs/hour | Forecast invocations/hour | Dispatcher statements | Shared hit + read | Rows written | Functions | Relations |
|---|---:|---:|---:|---:|---:|---:|---:|
| Blocked input scope | 58 → 0 | 58 → 0 | 144 → 115 | 8,558 → 8,457 | 17 → 12 | 21 → 22 | 200 → 200 |
| Settled idle | 0 → 0 | 0 → 0 | 34 → 34 | 7,487 → 7,493 | 1 → 1 | 13 → 13 | 194 → 194 |

The blocked-input statement reduction is 20.1% and repeats in every pair. Buffer differences are within noise. Fresh time averages are 13.335 → 12.900 ms blocked and 10.175 → 10.142 ms settled. Neither clears noise. Paired differences are baseline minus candidate milliseconds:

- Blocked: -0.730, 1.361, -0.005, 1.448, 0.099.
- Settled: 0.009, -0.982, -1.464, 1.144, 1.458.

WAL averages are 10,431 → 6,491 bytes blocked and 542 → 561 bytes settled. Full-page image variation prevents attributing those differences to the change. No WAL or time gain is claimed. The hourly invocation counts cover `matchup-forecast`. Start/finish bookkeeping and other edge invocations are outside this change.

The six-hour maximum, New York midnight, next tipoff or start, and projection freshness wakeups remain. Unchanged inputs renew expired cached validity through the existing input refresh path. The day comparisons cover those clock transitions. Neither expiry scheduling nor the fingerprint is changed.

Validation passed 10 focused SQL recipes and 42 Vitest tests in three files. Lint, app and test typechecks, Knip, canonical source parity, live catalog parity, and all 717 migration attestations pass. The full suite was not rerun under the focused-test instruction. No push is authorized.

Reproduction uses Node 22 and the local controller from [the pipeline report](pipeline-night.md). Set `DOCKER_CONTEXT=desktop-linux` and `PIPELINE_LOCAL=1`. Run `node tests/db/pipeline-night-forecast-diagnose.mjs` to settle the restore, `node tests/db/pipeline-night-forecast-verify.mjs` for SQL checks, and `node tests/db/pipeline-night-forecast-day.mjs blocked-N` for each hourly pair. Set `PIPELINE_REVERSE=1` on alternating pairs. Run the day script with `candidate` for settled idle, `aa` for A/A, and `control` for the expected rejection. The native fixture uses `node tests/db/pipeline-night-forecast-fixture.mjs blocked` or `settled`. Then measure that fixture with:

```sh
PIPELINE_BASELINE_REF=505d7734 node tests/db/pipeline-night-fresh.mjs forecast-blocked-final private/enqueue_matchup_forecasts,private/enqueue_scheduled_work,private/complete_forecast_input_chunk
```

Use `forecast-settled-final` as the output name for settled idle. [Portable results](pipeline-night-forecast-results.json) retain checkpoint hashes, arm order, backend IDs, counts, and timings. Raw full checkpoint JSON remains in `/tmp/fable-l7/evidence/`.

The locally reproduced cause is sufficient to generate empty minute wakeups. It does not establish that production has a held input scope. The restored data and the settled-day control do not reproduce the reported permanent loop. [Diagnostic SQL](pipeline-night-forecast-diagnostics.sql) records the missing queue state and full normalized slow RPC statements. The supplied snapshots end after the common REST parameter list, so exact attribution of the 750/342/176 ms rows is unavailable. All 26 matching signatures are listed in the portable results. No out-of-scope view or edge bookkeeping function is edited.

[Cleanup proof](pipeline-night-forecast-cleanup.json) confirms this project's containers, volumes, and network are absent. Local config is restored. Backup copies are deleted and the original backup hashes are unchanged. No production request, external notification, push, deployment, or CI run occurred.
