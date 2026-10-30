# Background worker fairness

The L7-5 replay starts with 330 pending checks, seven failed checks, 41 pending scans, one failed scan, eight revaluations, one notification scan, and one forecast input job. It holds two foreground leases. Due times match the supplied production window. New checks arrive each minute. An empty forecast arrives each minute until the input worker consumes the requests. An urgent estimate arrives every 15 minutes.

`c84063c4` always takes the empty forecast first. Checks use the other slot. After 240 simulated minutes, 106 old checks and all four other background kinds remain pending. `9894ce0c` moves the empty forecast behind the old checks. It drains the supplied backlog, but the input worker waits 202 ticks. That change alone does not provide timely service to the other kinds.

| Kind | First tick, c84063c4 | First tick, 9894ce0c | First tick, 05408 |
|---|---:|---:|---:|
| trade-revaluation-check | 1 | 1 | 1 |
| trade-revaluation-scan | Beyond 240 | 171 | 1 |
| trade-revaluation | Beyond 240 | 192 | 2 |
| notification-scan | Beyond 240 | 201 | 3 |
| forecast-inputs | Beyond 240 | 202 | 4 |

The candidate drains all 330 old checks, seven failed checks, 42 scans, eight revaluations, and both scheduler chunks. Failed items take their second attempt. The frozen six-tick service gate rejects `9894ce0c` and passes the candidate. This replay models worker completion. A separate native replay exercises the handlers.

The native replay runs `public.dispatch_work` and the actual `refresh-views` entry point over a local PostgreSQL REST bridge as `service_role`. It uses valid trades from the backup. The backup has three open trades, so the 337 check payloads and eight revaluation headers reuse those trades with distinct replay payloads. Other Edge workers are modeled. No notification is sent.

All 389 seeded items succeed in 423.201 seconds. Notification-scan starts at dispatch attempt 3 and forecast-inputs at attempt 4. Two input chunks consume all 80 restored matchup requests by attempt 6. The 330 old checks run in exact order before newer checks. All eight failed items succeed on their second attempt. The eight revaluations start 60.127–60.586 seconds apart. All 15 cached forecasts match an uncached context and the real forecast model. Native dispatch attempts run on demand; they are not minute ticks.

The fix stores `last_claimed_at` on `private.work_kinds`. Eligible background kinds take turns by their last claim time. Due time and ID select the oldest eligible row within a kind. A claim selects and locks one row, then recomputes the order before the next claim. This also removes the 128-row window that could contain only input chunks excluded from the fourth slot.

The urgent priority expression is unchanged. Ready forecasts retain priority. The four-worker limit, the input chunk limit, lease recovery, fencing, retry backoff, retired kinds, and per-league revaluation pacing remain in force. Service history survives fresh dispatcher backends and database restarts. No Edge or shared helper changes are required. The only production function changed is `private.work_claim`.

No additional one-time repair is needed. The supplied pending and failed rows are already due. The migration adds the nullable service-history column without resetting work state or attempts. Applying it again preserves recorded service history.

The migration is applied twice after the replay. Complete work-row hashes and service history remain identical. A restart of only this database container preserves both. Cron stays disabled. An expired test lease enters retry backoff, rejects the old token, receives a new token on retry, and completes on attempt two.

Neither baseline passes a newer eligible check over an older unlocked check. The candidate also records zero such bypasses. The production summary alone does not reproduce the reported newer-check bypass. Installed SQL and lock holders were requested from the orchestrator. No production connection was made.

[Read-only diagnostics](pipeline-night-worker-diagnostics.sql) include the deployed claim definition, the supplied old IDs, recent successful checks, retirement state, and transaction lock holders. Relation locks identify candidates; `pg_locks` does not expose every held row lock. The production within-kind bypass remains unverified.

The latest setup instruction names the mini project `pt4bafablesr`, ports 642xx, and `lanes/fable-ui27`. This run uses that project only. The source remains on the L7 worktree branch. The private backup restore uses two CPUs, 1 GiB, 224 MB shared buffers, and 384 MB effective cache. Other lanes run concurrently. No measurement lock is used.

Five interleaved fresh-backend pairs compare the production claim function from `c84063c4` with the candidate. Ten distinct backend IDs are recorded. The restored fixture has due retention work. Both arms perform the same 6,256 existing writes; the candidate adds two service-history writes. The baseline dispatches an empty forecast and one check. The candidate dispatches one check and one scan. No retention code is changed.

| Per dispatcher run | Baseline | Candidate |
|---|---:|---:|
| Statements, including nested calls | 949 | 948 |
| Shared buffers hit + read | 47,145.2 | 48,854.2 |
| Rows written | 6,256 | 6,258 |
| WAL bytes | 1,160,013 | 848,982 |
| Executed user functions | 52 | 52 |
| Application relations and indexes | 321 | 321 |

Fresh paired differences, baseline minus candidate milliseconds, are 0.843, -1.444, -2.007, 5.023, and -1.717. Noise is 9.397 ms. No time, buffer, statement, or WAL gain is claimed. WAL varies with full-page images. Function and relation counts are footprint proxies; direct syscache misses are not measured. This change fixes service latency.

The [portable results](pipeline-night-worker-results.json) retain the replay counts, FIFO checks, native handler results, five paired measurements, retry checks, and catalog validation. Nine focused SQL recipes pass. Live validation matches 728 migrations, 27 audited functions, 25 triggers, two policies, seven table boundaries, and nine indexes.

The single final full Vitest run passes 4,955 tests, skips 48, and fails zero. It covers 515 passing files and 16 skipped files. The 61 focused Vitest tests pass. Lint, both typechecks, Knip, and canonical source parity pass. The full suite starts after stack cleanup. [Cleanup evidence](pipeline-night-worker-cleanup.json) confirms no project containers, volumes, networks, worker listeners, copied backups, or temporary bundles remain. Both configs are restored. Original backup hashes are unchanged.

Run `PIPELINE_DB_PORT=64222 PIPELINE_EVIDENCE=<lane>/evidence node tests/db/pipeline-night-worker-mix.mjs` on the private stack. `PIPELINE_MIX_RED=1` records both controls without enforcing the six-tick candidate gate. Run `pipeline-night-worker-verify.mjs` for the focused SQL recipes. Run `pipeline-night-worker-replay.mjs` for the actual refresh worker. Its `seed` mode prepares the fresh-backend measurement fixture.
