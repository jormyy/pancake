# Pipeline night

The retained change bounds season-average lookup in `public.get_matchup_forecast_context` to the two rosters.
It keeps the existing averages view and the prepared/unprepared context choice.
Migration `20261214005400_pipeline_context_bound.sql` replaces the function without changing its signature, owner, grants, or dependencies.

The local follow-up also retains idle probes in `public.get_live_poll_work` and `private.flush_player_stats_hints`, plus helper inlining in `private.enqueue_scheduled_work`.
The other requested items remain unchanged.
[Local fresh-backend results](#local-fresh-backend-follow-up) supersede mini startup timings.
The mini's plan-discarded calls did not represent a new cron backend.
The caller-scoped generic-plan experiment did not earn retention.
Its apparent preparation gain disappeared after ten warm-up calls.
Player linking and import resolution became slower under that experiment.

## Method

The baseline is main `952580ce3204598d1fd120b3f121d166c7626028`, release 2.11.1.
The private mini project is `pt4bafablel7`, ports `648xx`.
Only Postgres runs. No production service is contacted.
The October 28 backup is restored at its recorded migration baseline and migrated to the branch.
The restore verifies 290,940 dump tuples before deleting the transferred backup copies.
The migrated database contains one league, 2,618 players, 8,430 games, and 245,097 game-stat rows.
Postgres has two CPUs, 1 GiB, 224 MB shared buffers, and 384 MB effective cache size.

Cron is disabled and database HTTP is fenced to the private port block.
Dispatch requests remain inside rollback transactions and never send notifications.
Every run was concurrent with other lanes. No `measure.lock` was used.
The stack controller owns `stack-slot-6.lock` with its mini PID and start time.
Its exit handler stops the project, restores config, deletes transferred backups, and releases the slot.

Each case has five interleaved A/B pairs, alternating AB and BA order.
Noise is the larger of the baseline range and ten percent of the baseline mean.
Each pair runs against the same restored data and fixed business clock.
The primary live clock is October 29 at 23:00 UTC.
The workloads use a 30-player synthetic box for a real scheduled game, 24 queued jobs, four busy workers in shed mode, actual roster/history/projection inputs, and a forecast computed by the existing worker code.
The final dispatcher fixture uses eight actual work kinds and distinct synthetic payloads.
Each arm asserts 24 stored jobs and four unexpired leases in shed/paused cases.
An earlier fixture coalesced identical payloads into one item; its dispatcher/live-cycle samples were replaced in the final run.
The live cycle ingests a changed box, captures scoring inputs, publishes matchup points, dispatches the essential totals refresh, and reads the compatibility forecast context.
The forecast worker's prepare, prepared read, and completion calls are measured separately.

Fresh calls discard plans and start from each case's specified application state.
The final run checkpoints and evicts available shared buffers with the stock `pg_buffercache` extension before each A/B arm.
Warm calls reuse the first call's plans, buffers, and resulting application state.
An unchanged second ingest and an already-completed second forecast therefore do less work.
Shared-buffer eviction does not flush the VM's filesystem cache.
The extension is measurement instrumentation on the private stack; the migration adds no extension or dependency.

`EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, FORMAT JSON)` records each call.
Statement deltas include nested SQL and the measured query wrapper.
They exclude the outer EXPLAIN utility statement, collector configuration, and deterministic clock/UUID instrumentation.
Their key includes query ID, executing role, and top-level status.
Rows written come from per-table transaction counters. Counts include trigger work.
WAL and buffer counts are inclusive outer-plan counts, so nested totals are not added twice.
Follow-up counts include active work items, dirty forecasts, pending live refreshes, and queued local HTTP requests.
The statement, buffer, row, WAL, and follow-up measurements are observations rather than acceptance targets.

An early long replay exhausted the 1 GiB container while accumulating function replacements and rollback scenarios in one backend.
The early case runs use a fresh backend per case and retain interleaving within the case.
The final live-cycle timings and provider-selector trial use a fresh backend per A/B pair, after the audit backend closes.
The repeat command now uses that separation for every case.
Later shared-mini interruptions also closed database connections.
Completed cases were resumed without repeating their samples. An interrupted case was discarded and rerun as five complete pairs.
An earlier statement-counter key omitted the executing role. Those counts are excluded from the portable evidence.
The timing, buffer, WAL, and equivalence observations from those experiments remain separate from the final counter-corrected run.

## Frozen correctness gate

Commit `3bbd6df4` freezes the output, row-diff, follow-up, freshness, and noise gates before the production change.
Ten unit controls include changed output, changed rows, changed work, worse freshness, insufficient pairs, mismatched pairs, and gains within noise.
Two database-backed controls deliberately change the returned ingest count and an NBA game's stored score.
Both are rejected by the same gate used for the candidate.

Quality checks run with row audit triggers outside the timed calls.
They compare literal JSON return values and per-table multiset row diffs, including trigger writes, timestamps, generated IDs, queue fields, and internal cache fields.
Both arms start from the same data. Clocks, UUID generation, and sequence starts are deterministic.
No returned field or stored row field is removed or normalized.
The additional native-clock control leaves PostgreSQL clock functions intact.
It uses five interleaved pairs of 20 context reads and reports per-call means.
The final live cycle compares 19 touched tables and two consecutive changed frames with four workers already leased.
Both frames expose the new home and away totals in `matchup_totals` before the compatibility context read.
Full-cycle timing includes the read after publication and does not measure provider-to-screen latency.
The standalone context recipe compares 15 restored matchups across three weeks, prepared and unprepared reads, the worker's prepared reader, missing IDs, null IDs, voided matchups, empty rosters/averages, and service-role access.

The initial SQL verification exposed fixtures that assumed empty production tables or synchronous forecast invalidation.
The forecast write gate now drains bounded worker chunks.
The live-poll recipe still requires a certified final to leave polling, while preserving polling for unrelated games.
The rookie-name recipe uses unique synthetic prefixes around its real-derived spelling variants.
The production functions for those behaviors are unchanged.

## Scope

Changed SQL function: `public.get_matchup_forecast_context`.
Changed private helpers: none.
Changed Edge functions and `_shared` helpers: none.
Its direct private helpers remain `private.matchup_forecast_inputs_ready`, `private.read_matchup_forecast_context`, and `private.compute_matchup_forecast_context`.
The existing `public.v_player_avg_fantasy_points` view is read without modification.
No league publication, refresh-view scheduling/coalescing, retention, statistics, invocation bookkeeping, screen function, or user-action function changes.

## Verification

All 28 SQL recipes pass.
Both database-backed negative controls pass by rejecting the deliberate mutations.
Deno reports 138 passed, zero failed, and eight ignored opt-in integration tests.
Lint, application typecheck, test typecheck, Knip, canonical SQL parity, migration attestations, and the live function catalog pass.

The full Vitest suite ran once on the Mac with Node 22 and two workers.
It reported 4,912 passed, one failed, and 48 skipped.
The failure required release notes to recognize the appended pipeline section.
The focused rerun of that contract, canonical SQL parity, and the frozen gates passes all 42 tests.
The full suite was not repeated.

## Reproduce

Run the stack lifecycle on the mini from `~/pancake-t_4ba51e0d/lanes/fable-l7/repo` after transferring the source bundle and backup.
Use the tool PATH and Docker socket specified for the lane.

```sh
node tests/db/pipeline-night-stack.mjs
PIPELINE_EVICT_SHARED=1 node --experimental-strip-types tests/db/pipeline-night.mjs candidate
PIPELINE_WARMUP_CALLS=10 node --experimental-strip-types tests/db/pipeline-night.mjs generic prepare_matchup_forecast_inputs generic-prepare-steady
PIPELINE_BATCH_SIZE=20 PIPELINE_NATIVE_CLOCK=1 node --experimental-strip-types tests/db/pipeline-night.mjs candidate context-compatible native-context-batch
node tests/db/pipeline-night-verify.mjs
PGOPTIONS='-c work_mem=1MB -c max_parallel_workers_per_gather=0 -c jit=off' SUPABASE_DB_URL=postgresql://supabase_admin:postgres@127.0.0.1:64822/postgres npm run check:db-function-catalog
node tests/db/pipeline-night-report.mjs ../evidence
touch ../stop
```

The lifecycle command remains running while the other commands use the private database.
Set `PIPELINE_RESUME=1` to retain completed cases after a shared-mini interruption.
Signal it or create `../stop` on every exit path.
Complete row diffs, nested statement deltas, logs, and samples remain in the lane's `evidence/` directory.
The portable numerical samples and quality hashes are in `pipeline-night-results.json`.
The verification receipt is `pipeline-night-verification.json`.
The cleanup receipt is `pipeline-night-cleanup.json`.
It confirms the private project is stopped, slot 6 and backup copies are removed, and config is restored.
Historical production top-40 snapshots are read-only context; their call rates and cache states differ from this replay.
These results do not estimate the current production call frequency or a production-wide billing reduction.

## Retained gain

The native-clock control reduces warm compatibility-context time from 21.492 ms to 2.915 ms per call, an 86.4% gain.
Its 18.578 ms gain exceeds the 2.806 ms baseline noise.
Fresh-plan batch means fall from 22.235 ms to 3.300 ms; the gain exceeds 3.186 ms noise.
Warm shared-buffer hits in one representative pair fall from 7,142.8 to 780 per call.
Both sides write zero rows and produce zero WAL.
The ordinary worker's prepared-context reader stays unchanged.
Current main's `loadForecastContext` calls that prepared reader, so the compatibility improvement alone does not establish a saving in the current worker path.
The separate single-call native-clock window was within noise under heavy contention and is retained in the numerical evidence.

## Items measured without a retained gain

| Item | Decision |
| --- | --- |
| `dispatch_work` | Unchanged. Final cases assert 24 mixed jobs and four unexpired leases in shed/paused mode. Earlier planner-trial queue samples were coalesced and are not acceptance evidence. |
| `get_trade_revaluation_inputs` | Generic-plan trial stays within noise. |
| `save_live_feed_snapshot_atomic` | New, duplicate, and ESPN fallback cases show no reliable planner gain. |
| `get_prepared_matchup_forecast_context` and `get_matchup_forecast` | The ordinary prepared reader stays unchanged. The first cached-read trial lacked a forecast; final reads use a computed worker forecast. |
| `update_score_points_atomic` | Real five-matchup writes stay unchanged. |
| `prepare_matchup_forecast_inputs` | Generic-plan improvement disappears after ten warm-up calls. |
| `complete_matchup_forecast` | No reliable gain for valid writes. The second call's expired claim is not evidence of a useful write-path gain. |
| `link_player_sources_atomic` and `resolve_player_imports_atomic` | Generic planning slows the 30-record source chunks. A separate direct-provider-column selector trial also stays within noise and is reverted. |
| `capture_score_inputs` | No gain beyond noise. |
| `get_live_poll_work` | No gain beyond noise. |

## Per-call measurements

The tables report means across five pairs.
Both phases use current main for items whose implementation remains unchanged.
Those A/A observations can vary with the concurrent mini workload and do not represent retained optimizations.

### dispatch-normal

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 222.137 / 7.964 | 277 / 117 | 1685.8 / 176.4 | 247 / 0.2 | 36 / 1 | 112206.8 / 538 |
| candidate | 80.3 / 2.235 | 277 / 117 | 1625.6 / 192 | 208 / 0 | 36 / 1 | 111293.4 / 538 |

fresh: gain 141.837 ms; noise 850.311 ms; within noise. warm: gain 5.728 ms; noise 24.697 ms; within noise.

Follow-up counts: work 43–43, forecast 15–15, live 0–0, requests 4–4.

### dispatch-paused

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 171.295 / 2.214 | 59 / 7 | 222.2 / 12.2 | 130.4 / 0 | 6 / 1 | 65867.4 / 546 |
| candidate | 25.316 / 0.442 | 59 / 7 | 159.2 / 12 | 105 / 0 | 6 / 1 | 57909.8 / 561.6 |

fresh: gain 145.979 ms; noise 732.342 ms; within noise. warm: gain 1.772 ms; noise 7.887 ms; within noise.

Follow-up counts: work 28–28, forecast 15–15, live 0–0, requests 0–0.

### dispatch-shed

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 33.025 / 9.805 | 67 / 50 | 275.6 / 95.8 | 169 / 0 | 6 / 1 | 52579.6 / 538 |
| candidate | 57.221 / 3.573 | 67 / 50 | 185.6 / 92 | 139 / 0 | 6 / 1 | 56723.2 / 538 |

fresh: gain -24.196 ms; noise 120.733 ms; within noise. warm: gain 6.232 ms; noise 42.39 ms; within noise.

Follow-up counts: work 29–29, forecast 15–15, live 0–0, requests 0–0.

### trade-pending

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 32.426 / 10.647 | 76 / 76 | 964.2 / 1002.2 | 528 / 0 | 0 / 0 | 0 / 0 |
| candidate | 37.097 / 10.111 | 76 / 76 | 735 / 998 | 485 / 0 | 0 / 0 | 0 / 0 |

fresh: gain -4.671 ms; noise 21.506 ms; within noise. warm: gain 0.535 ms; noise 3.523 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### live-duplicate

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 22.758 / 9.054 | 93 / 93 | 119 / 96.4 | 55.6 / 0 | 0 / 0 | 5225.4 / 0 |
| candidate | 27.096 / 7.826 | 93 / 93 | 118.4 / 97.6 | 57.2 / 0 | 0 / 0 | 3819.8 / 0 |

fresh: gain -4.338 ms; noise 14.88 ms; within noise. warm: gain 1.229 ms; noise 2.914 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### live-fallback

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 24.393 / 5.2 | 832 / 92 | 3540.8 / 99.6 | 654.6 / 0 | 97 / 0 | 877274.2 / 54 |
| candidate | 24.158 / 5.273 | 832 / 92 | 3551.8 / 100.4 | 656 / 0 | 97 / 0 | 871871 / 54 |

fresh: gain 0.234 ms; noise 2.439 ms; within noise. warm: gain -0.072 ms; noise 0.52 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### live-new

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 528.266 / 9.471 | 1510.4 / 93 | 8852 / 97 | 1640.4 / 0 | 148 / 0 | 1783934.2 / 54 |
| candidate | 536.852 / 12.851 | 1510.6 / 93 | 8729 / 96.4 | 1608.4 / 0 | 148 / 0 | 1804646.4 / 54 |

fresh: gain -8.586 ms; noise 898.549 ms; within noise. warm: gain -3.38 ms; noise 3.145 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### context-compatible

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 22.238 / 20.52 | 4 / 4 | 6955.6 / 7333 | 419.8 / 0 | 0 / 0 | 0 / 0 |
| candidate | 5.896 / 3.18 | 5 / 5 | 766.4 / 917.2 | 186.8 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 16.342 ms; noise 2.224 ms; beyond noise. warm: gain 17.339 ms; noise 2.052 ms; beyond noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### context-compatible-week-3

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 24.218 / 22.028 | 4 / 4 | 7233 / 7622.2 | 431.6 / 0 | 0 / 0 | 0 / 0 |
| candidate | 7.21 / 4.42 | 5 / 5 | 1017.2 / 1178.6 | 197.4 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 17.009 ms; noise 2.422 ms; beyond noise. warm: gain 17.609 ms; noise 2.203 ms; beyond noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### context-compatible-week-4

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 28.719 / 23.256 | 4 / 4 | 7247.2 / 7615.6 | 410.8 / 0 | 0 / 0 | 0 / 0 |
| candidate | 6.855 / 3.774 | 5 / 5 | 1018.6 / 1159.4 | 176.8 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 21.864 ms; noise 10.974 ms; beyond noise. warm: gain 19.482 ms; noise 5.38 ms; beyond noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### context-unprepared

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 104.464 / 71.56 | 4616 / 4616 | 18706.2 / 20266 | 1809.2 / 0 | 0 / 0 | 0 / 0 |
| candidate | 74.776 / 54.887 | 4617 / 4617 | 12440 / 13836 | 1562 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 29.689 ms; noise 54.214 ms; within noise. warm: gain 16.673 ms; noise 7.156 ms; beyond noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### context-unprepared-week-3

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 84.18 / 72.989 | 4065 / 4065 | 18420.2 / 19984 | 1814.2 / 0 | 0 / 0 | 0 / 0 |
| candidate | 68.617 / 56.387 | 4066 / 4066 | 12128 / 13527 | 1565 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 15.563 ms; noise 8.418 ms; beyond noise. warm: gain 16.603 ms; noise 7.299 ms; beyond noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### context-unprepared-week-4

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 108.026 / 88.511 | 4393 / 4393 | 19541.2 / 21087 | 1795.2 / 0 | 0 / 0 | 0 / 0 |
| candidate | 100.694 / 69.519 | 4394 / 4394 | 13236.2 / 14617 | 1545.8 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 7.332 ms; noise 41.373 ms; within noise. warm: gain 18.992 ms; noise 12.23 ms; beyond noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### live-cycle

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 3904.264 / 295.435 | 6889.4 / 6240 | 33549.4 / 26893.4 | 3111.4 / 3.6 | 192 / 134 | 1889277.6 / 65110.2 |
| candidate | 2384.659 / 222.629 | 6889.6 / 6241 | 26491.6 / 20542.2 | 3065 / 3.8 | 192 / 134 | 1915467.4 / 67239.2 |

fresh: gain 1519.604 ms; noise 6027.834 ms; within noise. warm: gain 72.805 ms; noise 241.53 ms; within noise.

Follow-up counts: work 29–29, forecast 15–15, live 0–0, requests 0–0.

### context-prepared

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 7.899 / 5.047 | 5 / 5 | 784.8 / 930.6 | 201.2 / 0 | 0 / 0 | 0 / 0 |
| candidate | 6.911 / 5.025 | 5 / 5 | 766.4 / 931.8 | 187.4 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 0.988 ms; noise 2.524 ms; within noise. warm: gain 0.022 ms; noise 0.612 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### forecast-read

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.832 / 0.506 | 3 / 3 | 43 / 10 | 35.6 / 0 | 0 / 0 | 0 / 0 |
| candidate | 0.635 / 0.481 | 3 / 3 | 2 / 10 | 14 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 0.197 ms; noise 0.846 ms; within noise. warm: gain 0.025 ms; noise 0.079 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### matchup-write

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 13.12 / 11.529 | 468 / 493 | 1604 / 1731.4 | 109.6 / 7.6 | 23 / 22 | 143336 / 10512.8 |
| candidate | 13.087 / 11.264 | 468 / 493 | 1586.8 / 1718 | 101.4 / 2 | 23 / 22 | 136726.8 / 10179 |

fresh: gain 0.033 ms; noise 1.312 ms; within noise. warm: gain 0.266 ms; noise 1.153 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 5–5, requests 0–0.

### prepare-fresh

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 112.824 / 1.281 | 4886 / 34 | 13789.4 / 251 | 1768.2 / 0 | 96 / 0 | 257444.6 / 0 |
| candidate | 81.422 / 1.4 | 4886 / 34 | 13659.2 / 251.2 | 1733.8 / 0 | 96 / 0 | 263799.4 / 0 |

fresh: gain 31.402 ms; noise 74.259 ms; within noise. warm: gain -0.12 ms; noise 0.128 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### prepare-reuse

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 2.028 / 1.236 | 34 / 34 | 159 / 250.8 | 91.8 / 0 | 0 / 0 | 0 / 0 |
| candidate | 1.849 / 1.289 | 34 / 34 | 159 / 251.4 | 92.4 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 0.179 ms; noise 1.01 ms; within noise. warm: gain -0.053 ms; noise 0.23 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### forecast-write

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 1.751 / 0.173 | 13 / 4 | 66.4 / 10 | 37.4 / 0 | 4 / 0 | 62589.8 / 54 |
| candidate | 1.594 / 0.185 | 13 / 4 | 59.6 / 10 | 31.2 / 0 | 4 / 0 | 63017.6 / 54 |

fresh: gain 0.158 ms; noise 0.942 ms; within noise. warm: gain -0.012 ms; noise 0.06 ms; within noise.

Follow-up counts: work 1–1, forecast 14–14, live 0–0, requests 0–0.

### link-players

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 9.143 / 7.676 | 334 / 334 | 398.8 / 384 | 87.6 / 0 | 0 / 0 | 164825 / 0 |
| candidate | 8.901 / 7.557 | 334 / 334 | 380 / 384 | 70 / 0 | 0 / 0 | 164825 / 0 |

fresh: gain 0.242 ms; noise 1.383 ms; within noise. warm: gain 0.119 ms; noise 1.123 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### resolve-players

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 9.226 / 6.684 | 310 / 310 | 497.4 / 499 | 147.4 / 0 | 0 / 0 | 164825 / 0 |
| candidate | 9.58 / 6.64 | 310 / 310 | 468 / 499 | 127 / 0 | 0 / 0 | 164825 / 0 |

fresh: gain -0.354 ms; noise 1.472 ms; within noise. warm: gain 0.044 ms; noise 0.668 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### capture-score

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 4.289 / 2.795 | 202 / 202 | 631 / 608 | 116.6 / 0 | 0 / 0 | 0 / 0 |
| candidate | 3.919 / 2.95 | 202 / 202 | 580 / 608 | 97 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 0.37 ms; noise 1.905 ms; within noise. warm: gain -0.155 ms; noise 0.351 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

### poll-work

| Phase | DB ms fresh / warm | Statements fresh / warm | Shared hit fresh / warm | Shared read fresh / warm | Rows written fresh / warm | WAL bytes fresh / warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.617 / 1.551 | 15 / 15 | 6.2 / 14 | 12.4 / 0 | 0 / 0 | 0 / 0 |
| candidate | 0.608 / 0.519 | 15 / 15 | 3 / 14 | 11 / 0 | 0 / 0 | 0 / 0 |

fresh: gain 0.009 ms; noise 0.172 ms; within noise. warm: gain 1.032 ms; noise 5.133 ms; within noise.

Follow-up counts: work 1–1, forecast 15–15, live 0–0, requests 0–0.

## Local fresh backend follow-up

The mini timings above are not acceptance evidence for cron startup. Each local arm opens a new backend. Docker Desktop uses project `pt4bafablel7`, 2 CPUs, 1 GiB, 224 MB shared buffers, and 384 MB effective cache. Other lanes run concurrently. No shared measurement lock is used.

The idle poll probe uses the existing date index and returns before planning the full poll query only when no game can need work. Five alternating A/B pairs used completed, freshly synced previous-night games and the upcoming slate. Shared buffers fell from 905 to 631. Relations including indexes fell from 15 to 13. Both arms wrote zero rows. Baseline WAL averaged 23 bytes from a first hint-bit update; candidate WAL was zero. Paired fresh time savings were 0.392, 0.432, 0.209, 0.388, and 0.123 ms. The decision uses buffers.

The original 49-check poll recipe passed. Exact complete results matched over 4,096 generated game cases. The cases cover DST, future games, null times, final markers, retries, and postponed games. The frozen quality comparison also passed with no touched rows.

The dispatcher inlining trial preserves statement order and conditions. It removes calls to `private.enqueue_stats_sync_dispatch`, `private.enqueue_process_trades`, and `private.enqueue_matchup_forecasts` from the normal scheduler. The private helper changed is `private.enqueue_scheduled_work`. The three existing helpers remain available for other callers. After restoring all discarded trial definitions, idle distinct functions fell from 14 to 11 and active functions from 24 to 21. Statements including the outer call fell from 31 to 28 idle and 168 to 165 active. Buffers did not improve. No dispatcher time improvement is claimed. Exact values and every touched table matched for normal, shed, paused, and two-frame live cycles. The live cycle touched 19 tables and retained current score publication.

The broad dispatcher idle return was not retained. Watchdog health is due every tick. The separate view scheduler repairs missing queue entries on idle ticks. Returning before those calls would change health or another lane's scheduling guarantees. Trade guards, caller guards, and a lighter nomination probe did not clear the 10% load-independent threshold. No changes from those trials remain.

The score-hint helper `private.flush_player_stats_hints` now checks its pending primary key before planning the emission query. The complete unchanged cron body fell from 1,062 to 882 shared buffers, five to four distinct functions, and 12 to 10 relations including indexes. Both arms used nine statements including the outer call, zero writes, and zero WAL. The final paired differences are recorded below; no time gain is claimed. Empty, due, and throttled quality cases matched exact values and row diffs. The due case touched three tables. Ten lock, timeout, overlap, paused, and retry checks passed. No league-version function or cron scheduling decision changed.

A maintenance trial skipped the injury query during its closed clock window. At a fixed maintenance boundary it removed one of 70 statements and 25 of 6,784 buffers, with unchanged function and relation counts. This is below noise and was reverted. No last-run cache was added: dynamic requests must still wake promptly, and the existing work keys retain daily completion records.

Thirteen focused SQL recipes passed on the local stack. Two broader recipes fail identically with baseline definitions: `work-queue-pre-tipoff` reports a started-player lock-context mismatch, and `io-write-reductions` reports writes during an unchanged screen publication. Those paths were not edited. PostgreSQL 14 on this Mac lacks psql's `getenv`; the local runner supplies only the four known local connection variables. Recipes run as the local migration owner so their temporary mocks have the same permissions as definer functions.

The final live-cycle comparison includes a populated forecast season cache. Separate savepoints gave cache revisions different PostgreSQL transaction IDs. The gate rejected that row difference. The harness now reverses the audited first arm in the same transaction before running the second arm. It restores exact old rows with triggers disabled, then restores normal triggers and the fixture. No returned field or stored field is ignored or normalized. The prepared two-frame comparison passes across 17 touched tables, including literal source revisions. An injected row change still fails this gate. Both frames expose their current totals in the returned forecast context.

The final catalog check found and restored two discarded trial definitions left installed in the lab. Affected dispatcher measurements were repeated. Earlier dispatcher prototype measurements are retained as rejected trials, not acceptance evidence.

The portable local results (external evidence: `pipeline-night-local-results.json`) retain 95 pairs, per-arm backend IDs, statement counts, buffer counts, writes, WAL, function names, relation names, follow-up counts where collected, and exact comparison hashes. Function counts track executed user functions. Relation counts track application tables and indexes held by the backend after the call. These are catalog-footprint proxies; syscache misses were not directly measured. The hint-drain function count includes its test wrapper. WAL differences in unchanged A/A cases reflect full-page images and hint bits and are not claimed as gains.

The active worker's prepared read, preparation, completion, ingest, matchup write, and score capture have no retained gain in this follow-up. The legacy compatibility read retains a 55% fresh buffer reduction; the current worker does not call it. Trade inputs and player sync were measured in the original round and received no new change here.

Start the local database with `DOCKER_CONTEXT=desktop-linux node tests/db/pipeline-night-local-stack.mjs`. Wait for `/tmp/fable-l7/ready` while doing source work. The controller copies the backup into `/tmp/fable-l7/backup`, verifies and restores it, and deletes the copies. Use Node 22. Run `tests/db/pipeline-night-local-verify.mjs` for the 13 focused SQL recipes and `tests/db/pipeline-night-native-fixture.mjs` for native workload setup. Run `tests/db/pipeline-night-fresh.mjs` for five fresh-backend pairs per scenario. Create `/tmp/fable-l7/stop` to stop only this project and restore config. No slot is used locally.

The first empty hint probe skipped the existing lease fence when a stale work header was supplied. The new exception-parity test reproduced the bypass: baseline raised `PT409` and the probe returned zero. Migration `20261214005404_pipeline_hint_lease.sql` limits the fast return to calls without request headers. Seven cases now match the original helper, including current, invalid, and expired leases and malformed headers. Apply `42c1ca71` with the hint optimization; `5c103059` alone is incomplete. The final retained buffer saving is 17%.

| Local scenario | Statements | Shared hit + read | Functions | Relations | Rows written | WAL bytes |
|---|---:|---:|---:|---:|---:|---:|
| final-dispatcher-idle | 31 → 28 | 5,175 → 5,188 | 14 → 11 | 110 → 110 | 1 → 1 | 542 → 554 |
| final-dispatcher-active | 168 → 165 | 8,161 → 8,181 | 24 → 21 | 185 → 185 | 23 → 23 | 16,582 → 13,878 |
| poll-final-idle | 2 → 2 | 905 → 631 | 1 → 1 | 15 → 13 | 0 → 0 | 23 → 0 |
| hints-combined-final | 9 → 9 | 1,062 → 882 | 5 → 4 | 12 → 10 | 0 → 0 | 0 → 0 |
| recheck-context-compatible | 4 → 5 | 11,770 → 5,293 | 3 → 3 | 109 → 109 | 0 → 0 | 0 → 0 |
| recheck-live-new | 1,518 → 1,518 | 12,327 → 12,345 | 40 → 40 | 108 → 108 | 153 → 153 | 752,234 → 468,150 |
| recheck-live-duplicate | 95 → 95 | 4,705 → 4,705 | 21 → 21 | 87 → 87 | 0 → 0 | 119 → 108 |
| recheck-prepare-fresh | 4,746 → 4,746 | 20,009 → 20,015 | 4 → 4 | 116 → 116 | 95 → 95 | 53,547 → 53,425 |
| recheck-prepare-reuse | 31 → 31 | 2,792 → 2,792 | 2 → 2 | 60 → 60 | 0 → 0 | 0 → 0 |
| recheck-context-prepared | 5 → 5 | 6,314 → 6,294 | 3 → 3 | 109 → 109 | 0 → 0 | 78 → 0 |
| recheck-forecast-write | 12 → 12 | 1,820 → 1,821 | 6 → 6 | 30 → 30 | 4 → 4 | 14,978 → 10,968 |
| recheck-matchup-write | 468 → 468 | 4,257 → 4,255 | 22 → 22 | 53 → 53 | 18 → 18 | 19,677 → 9,393 |
| recheck-capture-score | 207 → 207 | 2,972 → 2,972 | 9 → 9 | 54 → 54 | 0 → 0 | 0 → 0 |

Fresh paired differences are baseline minus candidate milliseconds, in interleaved pair order. Positive values favor the candidate. Time is not used to accept the ingest and forecast rechecks.

- final-dispatcher-idle: 0.393, -1.163, -0.159, 0.017, -0.144.
- final-dispatcher-active: -1.003, -0.291, 2.209, -0.601, 4.223.
- poll-final-idle: 0.392, 0.432, 0.209, 0.388, 0.123.
- hints-combined-final: 1.661, 0.190, -0.358, -0.113, -0.603.
- recheck-context-compatible: 11.395, 12.626, 11.649, 12.479, 11.493.

Final validation used Node 22. The single full Vitest run passed 4,918 tests and skipped 48. One test failed because the running stack had changed local config ports. After stopping the stack and restoring config, that file and the three affected contract files passed all 55 tests. The full suite was not repeated. Lint, app and test typechecks, Knip, canonical source parity, live catalog, and 716 migration attestations passed. Thirteen focused SQL recipes, ten timeout/locking checks, seven lease-parity cases, two cron policy checks, and four deliberate negative controls passed. Two broader SQL recipes retain their reproduced baseline failures, recorded above.

Local cleanup proof (external evidence: `pipeline-night-local-cleanup.json`) confirms that only project `pt4bafablel7` was stopped. Its containers, volumes, and network are absent. Config is restored. Copied backups and the generated native fixture payload are deleted. Original backup hashes still match the restore receipt. No push, deployment, production request, or external notification occurred.

## Forecast wakeup follow-up

Migration `20261214005405`, commit `f765a6d8`, aligns dispatcher forecast admission with the worker's pending-input fence. Finishing an input scope wakes runnable computation immediately. Five hourly pairs preserve exact forecasts at every day checkpoint and remove the empty workers produced by a held input backlog. The restored backup settles normally, so production queue evidence is still needed to attribute the reported persistent wakeups.

| Scenario | Forecast jobs/hour | Forecast invocations/hour | Dispatcher statements | Shared hit + read |
|---|---:|---:|---:|---:|
| Blocked input scope | 58 → 0 | 58 → 0 | 144 → 115 | 8,558 → 8,457 |
| Settled idle | 0 → 0 | 0 → 0 | 34 → 34 | 7,487 → 7,493 |

The statement reduction clears the 10% floor. Buffers and fresh-backend time do not. Both arms retain 75 legitimate computations per simulated day. All 504 checkpoint comparisons pass. Ten SQL recipes, 42 focused Vitest tests, lint, both typechecks, Knip, source and live catalog parity, and 717 migration attestations pass. The full suite is not repeated under the current focused-test instruction.

The truncated slow REST rows share `p_league_id,p_member_id,p_params`, matching 26 view functions and no forecast RPC. Exact names need the untruncated statement. The [forecast report](pipeline-night-forecast.md) contains paired times, expiry rules, reproduction commands, portable results, and read-only diagnostic SQL. No production connection or out-of-scope edit was made.

The forecast cleanup proof (external evidence: `pipeline-night-forecast-cleanup.json`) confirms the private stack and copied backups are removed, local config is restored, and original backup hashes are unchanged.

## Forecast input recovery on release 2.12

Main `c84063c4` is merged. Migrations `20261214005406_forecast_input_recovery.sql` and `20261214005407_forecast_ready_priority.sql` must accompany `05405`.
The claim policy demotes only an empty forecast worker blocked on due inputs. This prevents it from repeatedly occupying the third slot ahead of its overdue input chunks when two foreground leases are active. Ready forecasts retain their original priority. The four-slot cap, chunk reservation, retries, and active leases remain.

| Scenario | Overdue requests | Blocked dirty forecasts | Forecast claims |
|---|---:|---:|---:|
| Original policy after 60 empty-worker opportunities | 82 → 82 | 3 → 3 | 0 |
| Repaired loaded replay after three dispatcher ticks | 82 → 0 | 3 → 0 | 3 |

The migration makes pending or failed input jobs due, then enqueues an idempotent recovery job when no live input lease exists. This avoids a future retry header suppressing immediate continuation after 64 chunks. It retains the requests for normal processing. The actual input-worker entry point drains 64 and then 18 chunks. All 16 cached forecast values match clean recomputation. The replay proves recovery with production-main admission helpers before restoring the efficiency gate from `05405`.

Thirteen SQL recipes and 63 focused Vitest tests pass. The negative model-output control fails as intended. Source and catalog checks and 727 migration attestations pass. [Recovery details and commands](pipeline-night-input-recovery.md) include the loaded, restart, and final-attempt cases. Production slot occupancy and exact slow view-RPC names still require the supplied read-only diagnostics; no production connection was made.

Five alternating day pairs retain identical returned forecasts at all 84 checkpoints. Both arms perform 77 legitimate computations. The held-input hour drops from 58 empty forecast jobs and invocations to zero. A settled idle hour stays at zero. These 504 checkpoint comparisons use the final ready-priority policy.

| Final fresh scenario | Statements | Shared hit + read | Rows written | Functions | Relations |
|---|---:|---:|---:|---:|---:|
| Held input worker | 147 → 115 | 8,509 → 8,439 | 17 → 12 | 24 → 22 | 200 → 200 |
| Settled idle | 28 → 28 | 5,106 → 5,106 | 1 → 1 | 11 → 11 | 110 → 110 |
| Two held slots and legacy empty job | 71 → 95 | 7,455 → 7,618 | 6 → 10 | 19 → 19 | 190 → 190 |

The held-input statement reduction is 21.8%. Buffers and fresh time do not clear noise. The last profile dispatches the required input worker only in candidate arms, adding its statements and writes. It isolates claim priority; the held-input profile compares all four changed scheduler helpers with production main. The portable results (external evidence: `pipeline-night-input-recovery-results.json`) retain all 15 fresh pairs, backend IDs, running work kinds, writes, WAL, and paired times.

The final full Vitest run passes 4,953 tests, skips 48, and fails zero. It runs once after restoring local config and stopping the private stack. Code commit `9894ce0c` includes the ready-priority correction; do not ship `6029f978` alone. The recovery cleanup proof (external evidence: `pipeline-night-recovery-cleanup.json`) confirms the private stack, worker listeners, and backup copies are removed, config is restored, and original backup hashes match.

## L7-5 queue fairness

[The mixed queue replay](pipeline-night-worker-fairness.md) extends the forecast recovery with the supplied trade and notification backlog.
Migration `20261214005408_background_kind_fairness.sql` gives eligible background kinds service before one large kind drains.
Notification work starts at tick 3 instead of 201. Forecast input work starts at tick 4 instead of 202.
All 330 old checks and eight failed retries drain. Neither baseline reproduces a newer eligible check passing an older unlocked check.
The change addresses fairness. No new cost optimization is attempted.
The native worker completes all 389 seeded items in 423.201 seconds. All 15 cached forecasts match a clean recompute.
The final L7-5 full Vitest run passes 4,955 tests, skips 48, and fails zero. Nine focused SQL recipes pass.
The private mini stack is stopped, copied backups are deleted, and both configs are restored.
