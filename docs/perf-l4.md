# Background SQL costs

Method: paired private-database comparisons on restored data. Compare equal inputs and business rows, with setup outside measurements. Reject gains within ten percent or measured spread. The game-night comparison uses five ten-minute trials at 0.25 CPU. The statistics comparison uses five pairs per case at 0.125 CPU and 512 MiB.

| Work | Before | After |
| --- | ---: | ---: |
| Minute cron DB ms/min | 1,247.406 | 34.426 |
| Minute cron shared buffers/min | 64,201.24 | 1,570.90 |
| Fresh daily statistics DB ms/day | 4,331.773 | 116.691 |
| Fresh daily ANALYZE operations | 15 | 0 |
| One stale target DB ms/day | 4,863.279 | 212.688 |
| One stale target ANALYZE operations | 15 | 1 |

The statistics change is migration 04100 against main `952580ce`. Existing thresholds, partition changes and pending transaction changes decide staleness. Never-analyzed tables and invalid estimates still get sampled. Business table values remain equal. Diagnostic status and elapsed time reflect skipped work. These cases do not predict production staleness. The game-night comparison supports a cron-time claim; total SQL time remains inside noise.
These first-table gains are already shipped. Release 2.14 adds the package below.

Use the assigned private stack with cron and outbound delivery disabled. Run the focused recipes and canonical catalog check:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/statistics-freshness.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/live-refresh-shed.sql
npm run check:db-function-catalog
```

For a timing rerun, restore the same backup and take five baseline/candidate pairs with the stated CPU and memory limits. Keep captures outside Git. [Integration checks](release-2.12-integration.md) compare the ordered upgrade and reset.

## Release 2.14 workers

Keep migrations 04200 through 04600 from `climb/l4-212-ready` at `cebdf3bc`.
The baseline is release 2.12 `c84063c4`. Migration 04100 is already shipped.
Main's 05406–05408 `private.work_claim` stays unchanged.
Apply all missing versions in order with `--include-all`, then release the workers.
Migration 04300 precedes the shared invocation wrapper. Migration 04600 precedes `refresh-views`.
Older workers remain compatible while SQL is applied. No frontend change is required by this lane.

Five interleaved pairs per workload use restored fixtures, 0.125 CPU, 512 MiB memory,
224 MiB shared buffers and 384 MiB effective cache. Other lanes run concurrently.
Setup is outside measurement. Keep gains above 10 percent or observed spread.
The following counters establish the keeps. No new production traffic forecast is made.

| Change and workload | Before | After |
| --- | ---: | ---: |
| 04200 hourly cleanup cap | 5,000 rows | 512 rows |
| 04200 steady hourly buffers | 1,132.4 | 991.2 |
| 04300 startup calls per 200 leased workers | 400 | 200 |
| 04300 complete lifecycle calls | 600 | 400 |
| 04400 updates per 220 receipts | 420 | 220 |
| 04400 buffers per batch | 13,513.4 | 7,772.6 |
| 04400 WAL bytes per batch | 308,578 | 211,154.4 |
| 04500 calls per ten-trade scan | 11 | 1 |
| 04500 changed-input buffers | 1,839.4 | 758 |
| 04500 cached-input buffers | 1,214.6 | 469 |
| 04600 cached follow-up scans per twenty completions | 20 | 0 |
| 04600 cached background version publications | 20 | 0 |
| 04600 cached buffers | 14,594.4 | 4,940.4 |

The smaller cleanup cap trades backlog throughput for lower routine cost and smaller spikes.
A synthetic 20,000-row backlog needs 40 calls instead of four and more total buffers.
Startup time, buffers and WAL remain within noise; the call reduction is deterministic.
Reconciliation preserves outcomes, grace windows, transport evidence and idempotence.
Trade batching preserves queued valuation payloads and publications byte for byte.
The source gate retains all source-change publications and removes redundant scan receipts.
Trade-batch timing and mixed source-gate timing remain inside noise.
Stored JSON bytes and WAL bytes are separate metrics. HTTP transfer is not measured here.

Both 04500 and 04600 coalesce pending legacy work at apply time.
The oldest full-season scan keeps the earliest due time and loses its continuation cursor.
Superseded checks and duplicate scans retain attempts, errors and invocation links.
Running or locked work, existing revaluations and failed retries remain compatible.
The second cleanup covers checks committed between migrations. Repeated cleanup changes no rows.
The upgrade proof seeds 330 checks, 41 scans and eight valuations.
It leaves zero checks, one scan and all eight valuations byte-identical, preserving two failed retries
and failure evidence on 34 pending rows. All twenty proof assertions pass on the lane and integration stack.

The lane's completed native-clock confirmation has 1,210 observations with zero failures.
All 150 changed stat samples reach totals in one dispatch. Warm timing changes remain within noise.
Cold dispatches stay below five seconds. The strict 200 ms peak target remains unmet on that lane.
Full provider replay, urgent due-to-done timing, stress and sustained CPU headroom are not established by it.
Do not repeat the completed lab measurements for integration.

Run these focused recipes on the assigned private stack with Node 22 and PostgreSQL client 16 or newer:

```sh
for recipe in statistics-freshness live-refresh-shed cron-history-bounded retention-daily worker-retention-bounds invocation-start-lease work-lease-phases edge-invocation-worker-outcomes edge-invocation-reconcile edge-invocation-response-window trade-revaluation-batch trade-revaluation-source-gate trade-revaluation-upgrade trade-revaluation-scope trade-revaluation-fast trade-revaluation-coalesce refresh-player-averages screen-idle-version-gate worker-refresh-bounds; do
  psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f "tests/db/$recipe.sql" || exit 1
done
node tests/db/trade-revaluation-controls.mjs
deno test --cached-only --node-modules-dir=manual --allow-env --allow-net=127.0.0.1 supabase/functions/refresh-views/work.test.ts
npm run check:db-function-catalog
```

The SQL idle gate simulates sixty minutes; it does not wait an hour.
The six broken controls must fail their named assertions. Deno tests cover all four completion calls.
The release branch excludes lab raw captures and setup drivers.
Keep captures outside Git. [Integration](release-2.14-integration.md) records the combined checks.
