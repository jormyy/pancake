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
