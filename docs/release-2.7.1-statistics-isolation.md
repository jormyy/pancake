# Statistics maintenance isolation

The daily statistics job now runs outside the work dispatcher.
Migration `20261210000300_isolate_screen_statistics.sql` retires `analyze-screen-table` and removes its inline execution paths.
The separate `screen-statistics` cron job runs at 10:15 UTC.
Its command sets a ten-minute statement timeout, a two-second lock timeout, and 16 MB maintenance memory.
Each statement names one target relation.
A lock timeout records that target as skipped and continues.
An overall timeout affects only the statistics job's connection.

## Design

The leaf-table autovacuum settings remain unchanged.
Autovacuum does not analyze partitioned parents, so it cannot replace the complete daily job.
[PostgreSQL 17 documentation](https://www.postgresql.org/docs/17/routine-vacuuming.html) explains this limitation.
A parent ANALYZE gathers parent statistics and visits its partitions.
[ANALYZE documentation](https://www.postgresql.org/docs/17/sql-analyze.html) defines that behavior.

The dispatcher no longer reaches analysis through retention, partition creation, or trade ranking triggers.
This repair changes no Edge function or frontend code.
Outstanding analysis work becomes dead with cleared leases.
The work kind remains recorded with `retired_at` set.
Enqueue and claim exclude retired kinds; direct execution also retires a stale lease.
The catalog check rejects ANALYZE, VACUUM, and REINDEX in every owned function except the independent statistics function.
It also rejects SQL calls into that function.

## Restored-data timings

The private stack restores the local backup named `pancake-db-backup-2026-10-28`.
Both transferred files match their local SHA-256 digests.
The stack then applies all migrations through `20261210000200` before the repair.
The restored data contains 245,097 player game rows and 2,618 players.
Empty targets remain visible in this table.
These timings describe the private mini, not production latency.

Each measured command uses `statement_timeout=10min`, `lock_timeout=2s`, and `maintenance_work_mem=16MB`.
The normal ANALYZE statistics target remains 100.

| Target | Rows | ANALYZE milliseconds |
| --- | ---: | ---: |
| `analytics.player_season_totals` | 3,817 | 24.790 |
| `public.dynasty_rankings` | 852 | 6.386 |
| `public.matchup_forecasts` | 15 | 1.250 |
| `public.matchups` | 80 | 1.551 |
| `public.nba_games` | 8,430 | 49.625 |
| `public.player_game_stats` | 245,097 | 680.415 |
| `public.player_season_averages` | 411 | 2.328 |
| `public.players` | 2,618 | 24.334 |
| `private.forecast_input_revisions` | 2 | 0.892 |
| `private.forecast_player_history` | 0 | 0.652 |
| `private.forecast_projection_inputs` | 0 | 0.630 |
| `private.forecast_season_points` | 0 | 0.660 |
| `private.matchup_forecast_queue` | 15 | 1.040 |
| `public.roster_players` | 241 | 1.707 |
| `public.weekly_lineups` | 7,360 | 7.044 |

The 15 statements total 803.304 milliseconds in the first measurement.
The partitioned player game table takes 680.415 milliseconds.
The isolated function later visits all 15 targets successfully, totaling 801.326 milliseconds across its returned measurements.
These runs establish coverage and bounds; they do not establish a performance improvement.

## Reproduction and isolation

The old path cancels a real ANALYZE inside `private.work_execute`, called by `public.dispatch_work`.
The control uses `default_statistics_target=10000`, `vacuum_cost_delay=10ms`, and `vacuum_cost_limit=1` to slow analysis.
The dispatcher uses its real five-second statement limit.
It fails with SQLSTATE `57014` after 5,065.944 milliseconds.
Both queued items remain pending, including the essential item.
The error context identifies `ANALYZE public.player_game_stats`.
The control transaction rolls back.

The fixed concurrency recipe runs the actual statistics cron command in a separate connection.
Its controlled slow scan remains in `pg_stat_progress_analyze` beyond 5.1 seconds.
All dispatcher calls run under a five-second statement timeout.

| Phase | Calls | Minimum ms | Median ms | Maximum ms | Essential jobs dispatched |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before background analysis | 20 | 0.307 | 0.363 | 4.411 | 20 |
| During background analysis | 20 | 0.876 | 1.089 | 3.042 | 20 |

The median difference is 0.726 milliseconds; no call waits for the long-running analysis.
A separate lock control holds `public.players` exclusively.
The job skips it with SQLSTATE `55P03` and analyzes the other targets.
The recipe cancels only its own background connections and rolls back its fixtures.

The catalog rejects each injected ANALYZE, VACUUM, and REINDEX body.
The control restores the original dispatcher after every attempt.
The original catalog also identifies all four inline analysis helpers before the repair.

## Commands

Run database commands with the assigned private stack environment.
The isolation recipe requires restored production-shaped statistics.

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/statistics-maintenance.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/statistics-dispatch-isolation.psql
npm run test:db:statistics-catalog
npx vitest run tests/db-function-source-parity.test.ts
node --test scripts/season-sim/cron.test.mjs scripts/season-sim/cron-dispatcher.test.mjs scripts/season-sim/migration-cron.test.mjs
npm run check:quality
npm run check:db-function-catalog
npm run check:database-types
```

The targeted recipes cover statistics, scheduler health, queue behavior, and worker limits.
They also cover retention, trade statistics, and partition preservation.
The full unit suite is reserved for the requested pre-push check.
No push, deployment, or production connection occurs.


## Verification

Implementation commit: `2042b4dc`.
The private stack is stopped after verification.

| Check | Result |
| --- | --- |
| Source parity and migration/security attestations | 808 tests passed across three Vitest files. |
| Cron schedule, replay, and dispatcher checks | 21 Node tests passed. |
| Targeted database recipes | All 11 passed. |
| Statistics maintenance contract | 16 assertions passed. |
| Scheduler watchdog | 49 assertions passed. |
| Queue lifecycle | 27 assertions passed. |
| Queue schedules | 44 assertions passed. |
| Worker admission bounds | Eight assertions passed. |
| Worker retention bounds | 46 assertions passed. |
| Concurrent slow analysis | 40 of 40 essential items dispatched; 20 while ANALYZE stayed active. |
| Lock control | Locked target skipped; other targets analyzed. |
| Catalog mutations | ANALYZE, VACUUM, and REINDEX all rejected; original dispatcher restored. |
| Upgrade retirement control | Seeded pending analysis item becomes dead. |
| Database catalog and generated types | Both checks passed. |
| `npm run check:quality` | All 13 gates passed. |

The remaining database recipes cover minute gates, retention, partition preservation, and trade statistics plans.
The generated catalog, database types, and both attestations come from a clean private database.
That database applies the 675-migration production prefix before the four release 2.7.1 migrations.
Database types remain byte-for-byte unchanged.
The clean schema avoids adding data-dependent partition names to the client types.
The restored-data database also passes the catalog guard before cleanup.

Evidence stays in `/tmp/fable-r271-statistics-evidence` and the assigned private mini folder.
The original backup remains unchanged.
No production service, real email, push delivery, CI run, or deployment is used.

## Rollout and rollback

Apply the migration after the other release 2.7.1 migrations.
Pause dispatcher work and let the current dispatch finish before changing queue functions.
Confirm the retired kind has no runnable items.
Confirm the separate cron command has its own timeout settings.
Resume dispatch and monitor both jobs separately.

If the statistics job needs rollback, disable that job.
Keep the retired work kind and the dispatcher guard.
Do not restore inline maintenance to the dispatcher.

## Changed files

This follow-up changes 28 files relative to `9f6f75be`.

| Change | File |
| --- | --- |

| M | `docs/operations-scheduler.md` |
| M | `docs/production-migration-history.md` |
| M | `docs/release-2.7.1-integration.md` |
| A | `docs/release-2.7.1-statistics-isolation.md` |
| M | `package.json` |
| M | `scripts/check-db-function-sources.mjs` |
| M | `supabase/RELEASE-DB.md` |
| A | `supabase/migrations/20261210000300_isolate_screen_statistics.sql` |
| M | `supabase/sql/function-catalog.json` |
| D | `supabase/sql/functions/by-name/private/analyze_screen_table.sql` |
| D | `supabase/sql/functions/by-name/private/analyze_trade_value_rankings.sql` |
| M | `supabase/sql/functions/by-name/private/ensure_player_stats_partition.sql` |
| A | `supabase/sql/functions/by-name/private/refresh_screen_statistics.sql` |
| M | `supabase/sql/functions/by-name/private/retain_player_game_stats.sql` |
| M | `supabase/sql/functions/by-name/private/work_claim.sql` |
| M | `supabase/sql/functions/by-name/private/work_enqueue.sql` |
| M | `supabase/sql/functions/by-name/private/work_execute.sql` |
| M | `tests/db/excellence-trade-statistics-plan.sql` |
| M | `tests/db/excellence-trade-statistics.sql` |
| M | `tests/db/scheduler-health.sql` |
| A | `tests/db/statistics-catalog-controls.mjs` |
| A | `tests/db/statistics-dispatch-isolation.psql` |
| A | `tests/db/statistics-lock-holder.psql` |
| M | `tests/db/statistics-maintenance.sql` |
| A | `tests/db/statistics-slow-job.psql` |
| M | `tests/db/work-queue-lifecycle.sql` |
| M | `tests/e2e/db-security-catalog-attestations.json` |
| M | `tests/e2e/release-history-attestations.json` |

[Complete release file list](release-2.7.1-integration.md#every-changed-file) includes this follow-up.
