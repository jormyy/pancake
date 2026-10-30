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

Use the assigned private stack with cron and outbound delivery disabled. Run the focused recipes and canonical catalog check:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/statistics-freshness.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/live-refresh-shed.sql
npm run check:db-function-catalog
```

For a timing rerun, restore the same backup and take five baseline/candidate pairs with the stated CPU and memory limits. Keep captures outside Git. [Integration checks](release-2.12-integration.md) compare the ordered upgrade and reset.
