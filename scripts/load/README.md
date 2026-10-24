# Local database load comparison

Use a disposable local Supabase stack with a unique project ID and ports.
The runner rejects remote hosts and the default database port.
Restore the config and stop the stack when the comparison ends.

## Commands

Set `SUPABASE_DB_URL` from that stack's `supabase status -o env` output.
Reset the database before each new fixture load.
The seed stops scheduled jobs to keep background work out of the comparison.
A later database reset restores the schedules.

```sh
supabase db reset --local --version 20261020000007
npm run test:db:load-seed
node scripts/load/run.mjs measure scripts/load/before.csv
node scripts/load/run.mjs realtime scripts/load/realtime-before.csv
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261024000001_straight_to_ir.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261024000002_live_player_season_totals.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261024000003_reconciliation_writes_and_poll_gate.sql
node scripts/load/run.mjs measure scripts/load/after.csv
node scripts/load/run.mjs realtime scripts/load/realtime-after.csv
supabase db reset --local
```

The base version matches the migrations at `8a33034cdfcec1d32dc5a76ffb130ae7a205dd5f`.
The workload uses synthetic rows only.
Each measured workload resets `pg_stat_statements` and rolls back its writes.
The Realtime sample commits league hint updates and closes its own channel.
The runner uses the existing Supabase JavaScript package.

## Fixture and workload

| Input | Count |
| --- | ---: |
| Leagues | 20 |
| Players | 500 |
| Games | 470 |
| Player game stat lines | 235,000 |
| Edge invocation records | 30,000 |
| Pending invocation records | 500 |
| Running workers among pending records | 10 |
| Cron run records | 85,000 |
| HTTP responses | 30,000 |

The idle window calls three cron gates 60 times each.
The live window inserts 30 stat lines, corrects them, and calls the live gate 20 times.
The workload also reads ten player pages and reconciles invocations 12 times.
It calls the Edge dispatcher ten more times and runs the response cleanup once.
HTTP requests use a synthetic local endpoint and roll back before dispatch.
The workload forces one old cache refresh and runs the new hint flush when available.
The records span one synthetic season to keep both versions on the same input.

## Results from this MacBook

Times are one local sample in milliseconds.
The CSV files contain all recorded statements, including nested work.
The combined row sums outer statements only, so nested time is not counted twice.

| Work | Base ms | Changed ms |
| --- | ---: | ---: |
| Forced search cache refresh | 685.404 | 0.005 |
| Ten player pages | 101.293 | 131.322 |
| Twelve reconciliation passes | 28.826 | 28.713 |
| Eighty live gate calls | 12.742 | 11.704 |
| Ten direct Edge dispatch calls | 1.586 | 1.088 |
| Response cleanup, zero expired rows | 0.005 | 0.004 |
| Insert 30 stat lines | 3.403 | 4.884 |
| Correct 30 stat lines | 2.666 | 5.656 |
| Combined outer workload | 839.350 | 186.456 |

The combined workload uses 77.8% less database execution time.
Reconciliation updates 490 invocation rows, down from 610.
The statement still runs 610 times; unchanged rows produce no update.
The new totals add read and ingestion costs, shown above.
The daily cache refresh job is removed.

| Realtime sample | Polls | Total ms | Mean ms | Returned rows |
| --- | ---: | ---: | ---: | ---: |
| Base | 10 | 63.943 | 6.394 | 10 |
| Changed | 10 | 75.709 | 7.571 | 29 |

Both Realtime samples run for five seconds with one actual subscription.
Their returned row counts differ, so these samples do not show a polling speed gain.
The publication keeps its 23 existing tables.
Raw player stats, players, totals, and HTTP responses remain outside the publication.

## Findings and limits

- The old refresh scans all stat lines and rebuilds league scores. Incremental totals remove this work.
- Reconciliation repeats writes while workers run. The changed predicate stops those unchanged writes.
- The response join lacks a request ID index. An attempted index fails because the extension owns the table.
- The response cleanup already uses a time index. The local sample does not reproduce production's slow cleanup.
- Local reconciliation does not reproduce the production mean of 4.5 seconds.
- The dispatcher sample uses configured local values. It does not measure production Vault lookup or network latency.
- The live gate now returns before querying game work when a lease exists.
- Existing compact hints already keep raw stat writes out of Realtime. No publication table is removed without client evidence.

Production data, credentials, and endpoints are not used.
