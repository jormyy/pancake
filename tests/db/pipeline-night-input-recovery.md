# Forecast input recovery

Main `c84063c4` is merged. Migrations `20261214005406_forecast_input_recovery.sql` and `20261214005407_forecast_ready_priority.sql` accompany `05405`.

Two active foreground workers leave two slots. The original claim policy takes an empty forecast worker before its overdue input worker. Three active workers then exclude input chunks from the last slot. Repeating the empty forecast each minute leaves input work pending indefinitely. The SQL regression reproduces 60 empty workers, zero claims, 82 overdue requests, and three blocked dirty forecasts. Equal request timestamps alone drain normally.

The final fix demotes only an empty forecast worker blocked on due inputs. Due time and ID order then put the older input work first. Ready forecasts retain their original priority ahead of older background scans. The readiness check is inline in `private.work_claim`. No new function or permission is added. Claim limits, retry handling, active leases, the input chunk slot limit, and the forecast worker's existing capacity remain unchanged. Urgent work still takes the fourth slot ahead of forecast work. No Edge code or shared helper changes.

Commit `6029f978` initially demoted all forecast workers. A new ready-forecast ordering test rejects that policy. Apply `05407` with it; `6029f978` alone is not the final release candidate.

The repair statement runs only when requests or expiries are due and no live input-worker lease exists. It makes pending or failed input jobs due without resetting attempts. It then enqueues one migration-keyed recovery job. This also avoids a future retry header blocking continuation after the first 64 chunks. Applying the statement twice creates one recovery job. It leaves requests intact for normal input processing.

The private Docker restore uses project `pt4bafablel7`, two CPUs, 1 GiB, 224 MB shared buffers, and 384 MB effective cache. Other lanes run concurrently. No shared measurement lock is used. The loaded replay uses 82 matchup requests at the supplied identical timestamp, three dirty forecasts from an actual injury change, two active foreground leases, an old input retry in future backoff, and a pre-existing empty forecast job. Unrelated queued work is modeled as completed. No notification is sent.

The replay temporarily installs the three admission and completion helpers from production main `c84063c4`. It then applies `05406` and `05407`, proving recovery before adding the efficiency gate from `05405`. It runs the actual `refresh-views` worker entry point, its 64-chunk loop, lease renewals, and continuation over a local REST bridge to PostgreSQL as `service_role`. Other workers are modeled. Forecast computation uses the real model and prepared inputs. Each recovered forecast and every cached forecast are compared with an uncached SQL context and the real model.

| Checkpoint | Overdue requests | Dirty forecasts | Blocked dirty forecasts |
|---|---:|---:|---:|
| Before repair | 82 | 3 | 3 |
| Tick 1 | 82 | 3 | 3 |
| Tick 2 | 18 | 0 | 0 |
| Tick 3 | 0 | 0 | 0 |

All 16 cached forecasts match a clean recompute, including the three changed forecasts. Remaining request rows hold valid future wakeups. The repair preserves a healthy input lease, preserves attempts, retains all 82 requests before processing, and is idempotent. The deliberate model-status mutation fails the clean-recompute gate.

Thirteen focused SQL recipes and 63 focused Vitest tests pass. Ten policy checks cover starvation, ready work, mixed scopes, claim expiry, urgent capacity, and empty-worker cleanup. Typechecks, Knip, source and live catalog parity, and 727 migration attestations pass. The single final full Vitest run passes 4,953 tests, skips 48, and fails zero across 515 passing files and 16 skipped files. It runs after stack cleanup with the original config restored. [Portable recovery results](pipeline-night-input-recovery-results.json) retain the migration hashes, replay events, controls, and interrupted-worker cases.

Five alternating A/B day pairs compare production-main helpers with the final code. Every baseline creates 58 empty forecast jobs and invocations during the held-input hour. Every candidate creates zero. Both arms perform 77 legitimate model computations over the day. The settled-hour control creates zero jobs in both arms. All 504 complete returned-JSON checkpoint comparisons pass. The fixture clears claims left by fault tests before freezing its clock and asserts that the blocked workload has no active forecast claims. Earlier zero-work replays with future-dated claims are rejected as workload evidence.

Each fresh-backend profile uses five interleaved A/B pairs and ten distinct backend IDs. `recovery-blocked` compares the four changed scheduler helpers with main `c84063c4`. The other profiles isolate the claim policy with the accepted pipeline changes installed in both arms. Statements include nested calls and the outer call. Function counts track executed user functions. Relation counts track application tables and indexes held by the backend. Direct syscache misses are not measured.

| Fresh scenario | Statements | Shared hit + read | Rows written | WAL bytes | Functions | Relations |
|---|---:|---:|---:|---:|---:|---:|
| Two held slots and a legacy empty job | 71 → 95 | 7,455 → 7,618 | 6 → 10 | 3,421 → 5,343 | 19 → 19 | 190 → 190 |
| Settled idle | 28 → 28 | 5,106 → 5,106 | 1 → 1 | 560 → 542 | 11 → 11 | 110 → 110 |
| Held input worker | 147 → 115 | 8,509 → 8,439 | 17 → 12 | 9,248 → 6,509 | 24 → 22 | 200 → 200 |

The first profile starts the required input worker in every candidate arm. No baseline arm starts it. The additional 24 statements and four writes dispatch that worker; the baseline only dispatches the empty forecast. The held-input statement reduction is 21.8%, beyond the 10% floor. Buffers and times are within noise. Full-page images vary, so no WAL gain is claimed.

Fresh paired differences are baseline minus candidate milliseconds. Noise is the larger of baseline spread and 10% of its mean.

- Two held slots: -0.182, -1.633, -0.525, -0.814, -0.195. Noise: 1.005 ms.
- Settled idle: -0.084, 0.258, 0.242, -0.029, 0.291. Noise: 0.612 ms.
- Held input worker: 3.516, 2.096, 2.232, -3.341, -0.067. Noise: 4.579 ms.

Reproduce native measurements with `pipeline-night-forecast-fixture.mjs priority`, `settled`, or `blocked`. Run `PIPELINE_BASELINE_REF=c84063c4 node tests/db/pipeline-night-fresh.mjs recovery-priority private/work_claim` for the priority profile and use `recovery-settled` for settled idle. The blocked profile passes `private/enqueue_matchup_forecasts,private/enqueue_scheduled_work,private/complete_forecast_input_chunk,private/work_claim`. Run `pipeline-night-forecast-day.mjs recovery-blocked-N` with `PIPELINE_DAY_BASELINE_REF=c84063c4` and alternating `PIPELINE_REVERSE=1`. Run `pipeline-night-recovery-report.mjs` to rebuild the portable results.

Ship code commit `9894ce0c`, which includes the `05407` correction. Do not ship `6029f978` alone. [Cleanup proof](pipeline-night-recovery-cleanup.json) confirms only this project's resources were removed. Its worker listeners and copied backups are absent. Config is restored and original backup hashes are unchanged. No push, CI, deployment, production request, or external notification occurred.

A separate native test kills the actual worker after eight committed chunks and restarts only this database container. The committed state survives. Simulated lease expiry tests both a retryable lease and the final attempt. Before the repair, those cases recover in six and four minute ticks respectively. This rules out a permanently held database row lock surviving restart. Further tests and final measurements are recorded in the pipeline report.

The production queue summary does not show slot occupancy or input-worker outcomes. The starvation mechanism is reproduced locally; actual production occupancy remains unverified. The [read-only diagnostics](pipeline-night-forecast-diagnostics.sql) distinguish starvation, a worker error, a live lease, and a deployed function mismatch. No production connection was made.

Run `DOCKER_CONTEXT=desktop-linux node tests/db/pipeline-night-input-recovery.mjs load-repair` with Node 22 on the private stack. Use `restart` and `restart-final` for interrupted-worker cases. `PIPELINE_RECOVERY_CONTROL=1` deliberately changes a model status and must fail the clean-recompute gate. The focused SQL runner includes `pipeline-night-forecast-starvation.sql`.
