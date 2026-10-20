# Pre-tipoff season benchmark

Use a separate local Supabase project on ports 563xx. Never use the default Pancake stack.
The driver refuses other database hosts and ports.
Keep raw schedule payloads, logs, builds, and reports outside the repository.

## Prepare

1. Archive base `8b0ddd70c7c39eafae92d5772ac67d91f92fcbb9` outside the checkout.
2. Set its Supabase project ID to a unique value and use ports 563xx.
3. Start that isolated stack. Disable automatic cron execution on this stack only.
4. Permit its local database owner to change the benchmark clock and statement tracking.
5. Fetch and pin the schedule with `prepare-schedule.ts EVIDENCE`.

Save the isolated database's original HTTP function before installing the transport shim:

```sh
psql "$SUPABASE_DB_URL" -X -At -c "SELECT pg_get_functiondef('net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure)" > "$EVIDENCE/net-restore.sql"
```

The benchmark uses Deno and `postgres@3.4.9` as a harness-only SQL driver.
It adds no application dependency.

## Run

```sh
deno run --no-lock --node-modules-dir=none -A scripts/bench/prepare-schedule.ts "$EVIDENCE"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/bench/base-schema.sql
deno run --no-lock --node-modules-dir=none -A scripts/bench/pre-tipoff.ts old "$BASE_SOURCE" "$EVIDENCE" old
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/bench/restore-clock.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261014000001_pre_tipoff_lineups.sql
deno run --no-lock --node-modules-dir=none -A scripts/bench/pre-tipoff.ts new "$PWD" "$EVIDENCE" new-initial
```

Apply one measured candidate, then run the same NEW command with a different result label.
Do not run another workload against the database during measurements.
A fifth argument limits smoke runs to that many days. Smoke results never prove full-season savings.
`run-round1.mjs BASE_SOURCE EVIDENCE` runs both sides and tests one lease-write reduction.
It keeps the reduction only when statements and writes fall, no measured metric rises, every assertion passes, and stored lineups match the initial NEW run.

```sh
deno run --no-lock --node-modules-dir=none -A scripts/bench/compare.ts "$EVIDENCE" old new-initial new-improved
deno run --no-lock --node-modules-dir=none --allow-read --allow-write scripts/bench/report-metrics.ts "$EVIDENCE" old new-initial new-improved
deno run --no-lock --node-modules-dir=none --allow-read --allow-write scripts/bench/verify-tipoffs.ts "$EVIDENCE" new-initial new-improved
deno test --no-lock --node-modules-dir=none scripts/bench/oracle.test.ts
deno run --no-lock --node-modules-dir=none -A scripts/bench/dispatch-concurrency.ts
deno run --no-lock --node-modules-dir=none -A scripts/bench/lineup-concurrency.ts
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/bench/restore-clock.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$EVIDENCE/net-restore.sql"
```

The harness removes cron entries on the isolated stack so wall-clock jobs cannot mix measurements.
Restore required cron entries from their migrations before running the database integration suite.

## Workload and measurements

The fixed seed is 6172026. Ten teams each roster ten players and use eight starting slots.
The regular-season schedule has 1,230 played games and four postponed entries from the 2025–26 NBA season.
Each team uses PG, SG, SF, PF, C, G, F, and UTIL.
The same daily projections, injuries, late news, and postponements reach both implementations.

The clock changes simulated time. The HTTP driver translates actual Edge requests into parameterized SQL.
The driver runs real production RPCs, including projection selection and lineup writes.
It captures `net.http_post` requests and delivers them to the unchanged Edge handler.
Both sides use the same shims. The cron cadence comes from each side's production migration.
The fixture resets and statistics flush before each measurement.

`pg_stat_statements` records SQL calls and affected or returned rows, including nested function statements.
Nested statement rows can count the same row at several call layers.
Table counters record scanned or fetched tuples and inserted, updated, or deleted tuple versions.
Table reads include fixture updates and oracle reads. Table writes include all activity.
A separate production-write total excludes the three tables mutated only by fixture events.
Transaction counter sums are not used for subtraction because pending session statistics can overlap.
Clock and request-transport shim statements stay separate from production statement totals.
Database invocation telemetry must equal delivered Edge invocations.
Production statement totals exclude observer SQL and common clock/request shim SQL.
Transport queue internals, response processing, and reconciliation remain outside the measurement.
Wall time includes the driver, simulated clock, and correctness checks.
Both sides use one measured SQL connection. Hosted Edge startup, logging, cron polling, and real HTTP transport remain outside this measurement.
These measurements describe a simulated local database. They do not measure Supabase billing or hosted latency.

The NEW oracle independently solves the remaining slot assignment at each tipoff.
It checks legality, fresh Out exclusions, locked row identity, and best projected points.
Deliberately broken lineups prove the oracle rejects suboptimal, duplicate, ineligible, Out, and moved locked entries.
`compare.ts` scores saved database lineups against one fixed set of realized fixture points.

`report-metrics.ts` audits saved database counters without rerunning a season.
It preserves original outputs and writes corrected `*-measured-metrics.json` files.
`verify-tipoffs.ts` checks final stored rows at both the pre-tipoff observation and exact tipoff with the latest inputs.
It also reports after-dispatch news gaps in older evidence that has only pre-tipoff snapshots.

The controller accepts either lease variant as its starting source.
It prepares the unoptimized baseline, then tests the conditional renewal.
It refuses to overwrite existing measured outputs before any database operation.
Use a fresh evidence directory. For `--resume-old`, copy the pinned schedule and immutable OLD outputs first.
A failed experiment restores the starting source and native clock.

## Screen and job capacity profile

Registered commands:

| Command | Purpose |
| --- | --- |
| `npm run bench:profile -- FLAGS` | Measure reads and jobs on the isolated profile stack. |
| `npm run bench:profile:compare -- FLAGS` | Compare unchanged and changed scorers in interleaved pairs. |
| `npm run bench:profile:report -- INPUT.json OUTPUT.md` | Render a saved profile without a running stack. |
| `npm run test:bench:profile` | Check target guards, percentile summaries, and permitted provider reads. |

These aliases use the same Deno flags as the explicit commands below.

Use `profile.ts` for the broader fixed-volume workload.
It requires the isolated `pt0493perf` stack on API 56321 and database 56322.
Keep the source copy in `lanes/perf/source` and evidence beside it, outside the source tree.
Use base `725fa91363c7c0fb858c2647892136dd847f6146` for the independent baseline.
The interleaved comparison uses unchanged backend commit `16a12e893de247782136a44b15758539cf916126`.
Start Supabase with `-x studio,imgproxy,vector,logflare,supavisor` so its migrations apply.

```sh
node scripts/bench/profile-env.mjs --setup
supabase functions serve --no-verify-jwt --env-file .env.perf-functions
```

The environment helper checks the project ID and loopback ports before database changes.
It reads only that stack's `supabase status -o env` output.
It generates `.env.perf-functions` and `.env.perf-run` locally with mode 0600.
Never copy these files between machines or include them in evidence.
The setup step grants local measurement privileges inside `supabase_db_pt0493perf` only.
It needs the Docker CLI that reaches the assigned task VM.
Restart that stack's PostgREST container once after setup so pooled connections inherit nested statement tracking.

Run this command in a second shell with the same task environment:

```sh
. ./.env.perf-run
deno run --no-lock --node-modules-dir=none -A scripts/bench/profile.ts \
  --label baseline --rounds 5 --out ../evidence --jobs all
deno run --no-lock --node-modules-dir=none --allow-read --allow-write \
  scripts/bench/profile-report.ts ../evidence/baseline.json ../evidence/baseline.md
```

Use a fresh label for each run. Existing reports cannot be replaced.
The runner accepts `--jobs none`, `--jobs sql`, or `--jobs all`.
Every run recreates the same fixture and disables all cron entries on the isolated stack.
Do not use this database for integration tests without recreating its cron entries.

The seed is 6172026. IDs, league settings, stats, news, and roster ownership are deterministic.
The generator creates 600 synthetic players, 1,230 games, and 49,200 player-game rows for season 2026.
It creates thirty 12-team leagues with eleven scoring settings, 15-player rosters, daily lineups, and 26 matchup weeks.
It includes standings, waiver history, pending trades, future picks, news, rankings, activity, and both draft formats.
It uses synthetic identities and stats, rather than downloaded NBA history.
Draft nominations and completed waiver records represent history, rather than successful live settlements.

The read workload uses authenticated HTTP requests across all main screens.
Each request runs at least five times. The first sample remains in the reported range.
A readiness request waits for PostgREST's schema cache before measurement.
Response bytes count uncompressed bodies, rather than compressed wire traffic.
The runner resets statement and table counters before each named workload.
It separates top-level database time from nested statement totals to avoid counting work twice.
Table counters estimate logical tuples scanned or fetched. They are asynchronous and do not measure disk bytes.

Job measurements use unchanged production handlers loaded in Deno, with real local PostgREST transport.
Both JavaScript and database clocks use `2026-03-14T12:00:00Z` for active job cases.
The fixture changes that day's games to scheduled tipoffs at 23:00 UTC and enables all 360 optimizers.
This controlled job state follows read measurements and does not change their dataset.
The runner pins anonymous provider read responses under `EVIDENCE/providers/` and reuses them.
Keep this directory for AFTER runs. A prime invocation warms each handler before measured repeats.
Handler timings exclude Supabase Edge isolate startup. They are not hosted latency or billing measurements.

SQL job cases use rollback to repeat the same mutations.
Active waiver and trade cases include their fixture preparation in the measured transaction.
Their raw statements separate preparation from settlement costs.
HTTP handler repeats can change state. Inspect every returned result before comparing medians.
Idle results, failed imports, and rejected claims cannot establish successful ingestion or settlement capacity.
The raw report preserves all failures and responses.

Cron schedules describe dispatch predicate checks. Gates and leases determine actual worker invocation rates.
Sequential profile runs do not establish production overlap or a season-wide peak.
Use whole-season captures alongside this report when they exist.

The runner restores the native database clock in `finally`.
If a process is forcibly stopped during job measurements, restore it explicitly:

```sh
node scripts/bench/profile-env.mjs --restore-clock ../evidence
```

Stop the function server by its recorded PID, then stop only `pt0493perf` at the end.
Leave the shared Docker VM and other projects running.

```sh
deno test --no-lock --node-modules-dir=none scripts/bench/profile.test.ts
deno check --no-lock --node-modules-dir=none scripts/bench/profile.ts \
  scripts/bench/profile-handlers.ts scripts/bench/profile-workloads.ts \
  scripts/bench/profile-report.ts scripts/bench/profile.test.ts
npx eslint scripts/bench/profile-env.mjs scripts/bench/profile*.ts
```

Use `--phase reads` or `--phase jobs` to repeat one part of the profile.
Use `--only NAME,NAME` to repeat named cases against a freshly seeded fixture.
These options preserve all target guards and dataset checks.
The fixture verifies that every game and stat row matches its season week before measurement.
Twelve synthetic accounts each join all thirty leagues. This gives authorization checks a broad membership scope.
The stat fixture gives each synthetic player 82 games, which represents a dense capacity workload.
The fixed clock replaces both SQL clock functions by name and checks their returned values before jobs run.
The JSON preserves real elapsed time from `performance.now()`.
Ignore handler fields that use the simulated clock for elapsed time.
`requests.peakFetches` records simultaneous downstream fetches awaiting response headers, rather than scheduler overlap.
`sync-scores-engine-no-provider` measures scoring with provider recovery disabled after a prime run.
Compare it with the full `sync-scores` handler to separate scoring from source recovery.

The Dynasty Hub capacity read requests 600 forecast rows.
The trade analyzer case requests the fifteen selected roster players, matching its scoped API use.
The 600-player projection case measures capacity, rather than every screen's normal request size.
The only external POST selects a published Hashtag rankings view. It carries no account credentials.

The complete profile also measures rankings, projections, draft-order sync, nomination expiry, and cron housekeeping.
Source failures stay in the report. Cached failures do not establish successful import capacity.
The projection handler retains its two five-second provider delays.
Warm-up can rebuild twenty prior weeks across thirty leagues before sampling starts.
Allow substantial time for that cold history repair on the mini.
Five-round p95 uses the highest sample. It has limited tail resolution.

Run the read-only stale-week prototype after scoring creates fresh certificates, with no other workload running:

```sh
deno run --no-lock --node-modules-dir=none -A scripts/bench/profile-prototypes.ts \
  --label stale-weeks-prototype --rounds 5 --out ../evidence
```

This command alternates original and candidate SQL across five pairs.
It checks result equality for the current fixture and saves both plans and statement counters.
It changes no application function. Other scoring histories still need correctness checks before implementation.

The published-day stats import is an explicit probe, selected with `--only sync-stats-published-day-including-preparation`.
Include `sync-schedule,sync-players` in that selection so public identities load first.
The probe removes only synthetic benchmark rows for March 12 before importing real box scores.
It never deletes real player history. Other synthetic season rows remain intact.
Verify a positive `statLines` count before using this probe for throughput comparisons.

## Interleaved scoring comparison

Use two source copies on the isolated mini stack. Keep the BEFORE backend at the requested commit.
Copy the same benchmark scripts into both copies. Generate each copy's local environment with `profile-env.mjs`.
Keep the stack, fixed dataset, provider cache, and native Deno version the same.
Start from a fresh seeded profile and let the unchanged scorer finish its cold historical repair.
The warm fixture must contain 600 players, 49,200 stats, thirty leagues, and 600 certificates.
Run this cold preparation in the unchanged source copy, using a fresh label:

```sh
deno run --no-lock --node-modules-dir=none -A scripts/bench/profile.ts \
  --label warmup-before --rounds 1 --single-sample true --prime false \
  --phase jobs --jobs all --only sync-scores-engine-no-provider --out ../evidence-round2
```

Exclude that cold observation from the warm comparison.
The comparison refuses another dataset and refuses changed scores, standings, or notification content.

```sh
deno run --no-lock --node-modules-dir=none -A scripts/bench/profile-compare.ts \
  --label scoring-after --rounds 5 --out ../evidence-round2 --before ../before --after .
deno run --no-lock --node-modules-dir=none -A scripts/bench/profile.ts \
  --label reads-after --rounds 5 --out ../evidence-round2 --phase reads --jobs none --reuse-fixture true
```

The first command runs BEFORE then AFTER five times on one warmed fixture.
It installs each copy's canonical stale-week function before its run.
Each run measures scoring with provider recovery, scoring without recovery, and the stale-week RPC.
It also measures all 43 authenticated screen reads in both variants.
Each named workload resets statement statistics and saves its own snapshot.
The report saves source hashes, exact commands, machine load, memory, disk space, and output digests.
Each child uses identical flags, skips reseeding, and skips extra prime runs.
The explicit `--single-sample true --rounds 1` mode supports cold preparation and paired observations.
Standalone reports still require five rounds by default.
The final read command preserves the warmed dataset and measures all 43 screen-read cases.
Run the required capacity gate before these heavy commands. Run no other workload during a comparison.
Stop only the isolated stack after all checks and restore native clocks if a child is interrupted.

If the mini has no `psql`, use the stack's client through the guarded wrapper.
Add its executable to the lane-local tools directory:

```sh
mkdir -p ../tools
ln -s "$PWD/scripts/bench/profile-psql.mjs" ../tools/psql
export PATH="$PWD/../tools:$PATH"
```

The wrapper requires the postgres URL on loopback port 56322.
It uses only `supabase_db_pt0493perf` and rejects connection overrides.
It supports SQL files, statements, streaming input, and the test's `PGOPTIONS` timeouts.
It requires the task-local Docker route in `PATH`.

Run the certificate matrix explicitly after the profile fixture is seeded and warmed:

```sh
deno test --no-lock --node-modules-dir=none --allow-env --allow-read \
  --allow-net=127.0.0.1,localhost scripts/bench/profile-certificates.ts
```

This check requires the generated local environment and the primary league's fresh certificates.
It compares the old and new query results through rollback-only changes.
Cases cover missing/stale certificates, stat corrections, result races, consumed/mixed playoff rows, voids, and retired inputs.
The file stays outside default unit-test discovery because it needs the benchmark fixture.

## Span certificate regression

Run this check against the isolated stack with its generated local environment.
Place the unchanged backend at commit `16a12e89` in a sibling directory.
Keep the output directory outside both source copies.

```sh
deno test --no-lock --node-modules-dir=none -A scripts/bench/profile-span-certificates.ts \
  -- --before ../before --out "$PWD/../evidence/span-certificates.json"
```

This test creates and removes its own users, leagues, players, games, and calendar rows.
It needs no profile dataset or external provider.
Both scorers use real local API requests and the current database schema.
The BEFORE scorer hash must match the unchanged commit.
Each scorer first finalizes a fixture and certifies its maximum points.
An unchanged AFTER replay must reuse that certificate without maximum-point roster reads.
Separate fixtures then receive a last-week stat correction or a backdated IR designation.
The IR fixture records ownership before both weeks and designation before the last game's tipoff.
The test requires the start-week token to change and the start week to become stale.
It counts maximum-point roster reads to prove recomputation across every covered week.
It compares atomic publication values, stored matchup values, winners, and regular-season standings against BEFORE.
Cases cover a two-week playoff final and single-week regular-season controls.
