# Release 2.10 integration

The base is release 2.9.1, `ec739102`, on `release/p2-18`.
The existing UI merge and read-only trade preview fix remain included.
Contention commits `806e38f6`, `60f4318b`, and `26825639` precede the product and SQL test parts of `561a6c53`.
The pacing migration is renamed to `20261214001400`; the analyzer retains `20261214001300`.
Step 3 merges `climb/l4b-forecasts` at `a83d1ef7`.
The pending migration order is `00900`, `01100`, `01300`, `01400`, then `01500`, all under `20261214`.
Duplicate commit `096bdd73`, its migration, and the revaluation lane's bench files and knip entry are excluded.
The forecast lane is merged in full.

The forecast lane changes eight forecast functions.
None overlaps an earlier function edit.
`private.refresh_changed_screen_views`, `private.work_claim`, and the analyzer helpers remain byte-identical to step 2.
The forecast hint filter and event-only refresh repair retain their separate behaviors.
Shared files are knip, release notes, the function catalog, and both attestations.
The forecast rollout entry moves from the historical section into the current release table.

The private mini project is `pt4bafabler210`, using only ports `634xx`.
The supplied backup is restored and migrated through all 694 migrations ending at `20261214001500`.
The repository generators resolve both attestation conflicts and regenerate the function catalog.
All three artifacts regenerate identically. The 544-function catalog and live security contract pass.

Final checks:

- Forecast parity: 160 exact context and computed JSON pairs across 80 backup matchups on live and off days, against step 2 at `5dfdd141`.
- One preparation comparison adds 12 parity pairs. Six cold cases use 43 database preparation calls before and six after, one per matchup case. This measures call count, not a timing confidence interval.
- Twenty-five SQL recipes pass: nine forecast recipes and all sixteen step 1–2 recipes. Fingerprinting passes 28 assertions; foreground priority and pacing pass 15.
- Forecast concurrency passes blocking, parallel publication, stale-result rejection, token fencing, retry, corruption, and outsider controls.
- Refresh contention reproduces the old timeout at 182.88 ms. The repair completes in 22.52 ms while the queue row remains held. Duplicate completion and mixed publication pass.
- The slow-screen guard passes at one CPU and 1 GiB after normal screen-cache initialization. Player reads are 18.541 ms p95 against the unchanged 60 ms limit.
- Focused Vitest: 917 pass across 11 files. Edge forecast tests: 10 pass.
- `node --test scripts/season-sim/*.test.mjs`: 346 pass.
- `npm run check:quality`: all 13 stages pass, including lint and configured typechecks.

Steps 1–2 ran full Vitest once: 4,716 pass, 48 skip, and one release-note failure repaired with a 25/25 affected-file rerun.
Step 3 follows the final testing instruction and leaves the full suite for the pre-push gate.
The earlier fixture fix uses distinct payloads to retain 22 queued jobs.
Release notes preserve the baseline and rollout sentence required by the contract test.
No extra product fix is needed.

The database stays capped at 1 GiB; insert batching preserves all 301,473 backup tuples.
Cron stays disabled and external database HTTP stays blocked.
The stack is stopped, configuration restored, shared lock released, and transferred backups deleted.
No production request, real message, push, PR, CI, or deployment is used.
Mini evidence remains under `~/pancake-t_4ba51e0d/lanes/fable-r210/`, including `step3-*` reports and `step3-recipe-evidence/`.

## Step 4

Included, in order: notification commits `582b2f5d`, `ad67ed44`, `9a243c32`; ingest `a05cdf23`; game-day jobs `dc67cd8b`; scan cuts `1abf27e2`.
The notification insert migration is `20261214000600`, preserving production's `00500` slow-screen migration.
Notification bench files and perf documentation are excluded. `eccc58d9` has only tests/docs and is skipped.
Neither `096bdd73` nor `561a6c53` is taken again.

Broadcast `22889547` is dropped under the requested drop-first rule.
Its SQL recipe passed, but the new transport probe stopped at fixture creation because it omitted a required client request ID.
Delivery was not reached; this is not evidence of a Broadcast product defect.
No Broadcast client or migration changes remain.

The notification scanner retains both season bounds and the idle-lineup gate.
No product function is overwritten by another lane.
The scan lane's identity helper grant preserves the ingest service-role index contract.
Replay-port and ingest retry changes are combined in the shared harness.
The only check fixes are the merged Knip entry lists and `NODE_ENV` fields in `tests/perf-l4c/window-config.test.ts`.

The final rehearsal restores the backup, applies the supplied 689 migrations through `20261214000700`, then applies all missing release migrations through `20261214002100`.
All 700 versions are unique. Every production migration remains unchanged.
The backdated notification migrations require `--include-all`; apply missing database migrations before the strict release preflight.
Both attestations and the 544-function catalog regenerate identically and pass live checks.

Final verification: 37 SQL recipes pass, including the pick-bounds recipe with the existing retained trade-value fixture; 17 scan-output pairs match; refresh contention, slow-screen guards, and forecast concurrency pass.
Focused Vitest passes 945 tests, with the three corrected fixture tests passing again. Edge tests pass 106, with one ignored. The season harness passes 353.
All 13 quality stages pass, including lint and configured typechecks. The full suite remains reserved for pre-push under the final testing instruction.
The private stack is stopped, the lock released, and all transferred backup copies removed. No production contact, push, PR, CI, or deployment occurs.
