# Local database load comparison

Use a disposable local Supabase stack with a unique project ID and ports.
The runner rejects remote hosts and the default database port.
Keep generated CSV files outside the checkout.
Restore the configuration and stop only the assigned stack after measurement.

## Commands

Set `SUPABASE_DB_URL` from that stack's `supabase status -o env` output.
Set `EVIDENCE` to an external output directory.
Reset the database before each fixture load.
The seed stops scheduled jobs to exclude background work; a later reset restores them.

This comparison isolates the original IR, season-total, and reconciliation migrations.
Its historical baseline is deliberate; it does not measure the complete current release.

```sh
supabase db reset --local --version 20261020000007
npm run test:db:load-seed
node scripts/load/run.mjs measure "$EVIDENCE/before.csv"
node scripts/load/run.mjs realtime "$EVIDENCE/realtime-before.csv"
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261024100001_straight_to_ir.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261024100002_live_player_season_totals.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261024100003_reconciliation_writes_and_poll_gate.sql
node scripts/load/run.mjs measure "$EVIDENCE/after.csv"
node scripts/load/run.mjs realtime "$EVIDENCE/realtime-after.csv"
supabase db reset --local
```

For a current-release sample, reset to the repository head before loading the fixture.
Use a new output name and record the source revision.
Use the [benchmark guide](../bench/README.md) for paired current-release measurements.

## Workload and interpretation

[`seed.sql`](seed.sql) defines the synthetic dataset and its exact counts.
[`workload.sql`](workload.sql) defines idle gates, player pages, stat writes, reconciliation, dispatch, and response cleanup.
[`run.mjs`](run.mjs) collects database statement timings and a real Realtime sample.
Each measured SQL workload resets `pg_stat_statements` and rolls back its writes.
The Realtime sample commits league hints and closes its own channel.
HTTP requests use a synthetic local endpoint.
The workload forces the old cache refresh and calls the new hint flush when available.

Keep nested statement timings separate from outer workload totals to avoid counting work twice.
Compare identical fixtures and record returned rows, errors, runtime versions, and sampling duration.
Different Realtime row counts cannot establish a polling speed gain.
Local timing does not establish hosted latency, network cost, or production capacity.
A response cleanup with no expired rows does not measure backlog removal.
The extension owns its response table; do not add an index outside the supported schema.

The current release retains publication tables needed by deployed clients and rollback.
Raw player stats, totals, and HTTP responses remain outside the Realtime publication.
Use [database release steps](../../supabase/RELEASE-DB.md#next-release) for delayed publication cleanup.
