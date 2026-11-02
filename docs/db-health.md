# Database health

## Final-layout baseline

The logging-off replay verifies both October 29 and October 30 on source `7ade191c869f4a1c8783bdae9dd49af9ca82855e`.
All 667 migrations are applied. It completes 13 games, 450 stat rows, and 4,036 live checks.
The final-game query finds zero games without stats. The six-table draft feed delivers its update.
The statement reset time and server start remain unchanged across the measurement.
The host capture runs October 28, 22:18:52–23:09:18 UTC, while the simulated dates are October 29–30.

| Measure | Result |
| --- | ---: |
| Database allocation | 242,936,979 bytes |
| Top-level statements | 1,089,692 |
| Workload interval | 3,025.755 seconds |
| Shared blocks read | 40,918 |
| WAL bytes | 289,635,297 |
| Temporary bytes written | 0 |
| Sampled peak connections | 29 |
| Samples with lock waits | 0 |
| Peak database container memory | 977.600 MiB |

The interval contains 745 resource samples.

The endpoint has 0 waiting sessions and 0 idle transactions.
All 30 daily ANALYZE tasks succeed across the two simulated days.
During the window, 51 reported relations receive automatic analysis.

| Relation, including partitions | Estimated live rows | Estimated dead rows | Allocated bytes |
| --- | ---: | ---: | ---: |
| `public.players` | 2,618 | 77 | 3,530,752 |
| `public.player_game_stats` | 246,109 | 187 | 143,884,288 |
| `public.player_season_averages` | 1,016 | 50 | 1,064,960 |
| `analytics.player_season_totals` | 3,914 | 122 | 2,244,608 |
| `private.work_items` | 3,429 | 249 | 1,359,872 |
| `public.notification_outbox` | 679 | 0 | 860,160 |

These row counts are PostgreSQL estimates. They do not measure exact bloat.
Synthetic historical boxes follow the restored calendar; they do not establish a hosted user limit.

The final source passes 4,267 Vitest checks with zero failures and 45 skips.
The season and health Node suite passes 392 checks with zero failures and five skips.
Quality, the native three-season simulation, catalog, loopback types, and all 667 migration attestations pass.
Only documentation and the minute-dispatcher test differ from the replay source.

Historical sections below retain their original measurement limits.
The remaining broad statement, read/write/retention, and pagination reviews are deferred to the climb.

## Run the report

Use Node 22 and the private database URL from its local stack environment.
The command accepts only `127.0.0.1:57422/postgres`.
It opens a read-only transaction with a 15-second statement limit and a 500-millisecond lock limit.
The report includes normalized statement text. Store it as private evidence.

```sh
export PATH="$PWD/scripts/db-health:$PATH"
pancake db-health --output ../evidence/db-health.json
node scripts/db-health/index.mjs --sources > ../evidence/db-source-audit.json
node --test tests/db/health-report.test.mjs
```

`SUPABASE_DB_URL` supplies the connection.
Output files use owner-only permissions when created.
The source scan lists review candidates; it does not prove that a write lacks a guard.
After the timing workload finishes, run `pancake db-health --verify` for the isolated fixture checks.
It checks drain timeouts, deferred version publication, and client-subscription logical delivery.
The command uses the same private database allowlist and removes its fixture rows.

## Recorded baseline

Capture: October 28, 2026, at 07:36:19 UTC.
Source: the supplied October 28 backup, loaded into the private database at 608 migrations through `20261116000500`.
The import contains 58 tables across public, private, analytics, and the required Auth user records.
The removed `public.cron_dispatch_state` table is excluded because the current migrations replace it.
The restore preserves 31 work kinds, 136 retention rules, and 44 notification kinds.
The raw backup notification catalog is replaced by the current migration catalog.

| Measure | Baseline |
| --- | ---: |
| Database size | 168,815,763 bytes |
| Tables in the health report | 109 |
| Indexes in the health report | 366 |
| Statement entries | 499 |
| `pg_stat_statements.track` | `all` |
| Waiting sessions | 0 |
| Idle transactions | 0 |
| Nonunique indexes with zero scans | 193 |
| Bytes in those zero-scan indexes | 48,349,184 |
| Identical index definitions, ignoring names | 0 |

This initial snapshot precedes the completed screen walk and the two-day workload.
Zero scans in this sample do not justify an index drop.
Table row counts below are PostgreSQL estimates after `ANALYZE`.
Dead-row estimates are zero after this fresh import; this does not establish production bloat.

| Table | Rows | Table and TOAST bytes | Index bytes | Total bytes |
| --- | ---: | ---: | ---: | ---: |
| `public.player_game_stats` | 245,097 | 53,231,616 | 59,850,752 | 113,082,368 |
| `public.sync_runs` | 10,674 | 1,286,144 | 4,997,120 | 6,283,264 |
| `public.weekly_lineups` | 7,360 | 1,064,960 | 3,923,968 | 4,988,928 |
| `public.edge_invocations` | 10,533 | 1,613,824 | 2,318,336 | 3,932,160 |
| `analytics.player_season_totals` | 3,817 | 1,392,640 | 434,176 | 1,826,816 |
| `public.notification_outbox` | 257 | 172,032 | 131,072 | 303,104 |

Player statistics, edge invocations, work items, beacons, events, receipts, and the screen queue have fillfactor 90.
Their vacuum and analyze scale factors are 0.02 and 0.05, with thresholds of 50 rows.
Migration `20261119000200` also applies these settings to sync runs, weekly lineups, four screen aggregates, and player season totals.
All six requested partition targets remain ordinary tables in this baseline.

| Role | Statement timeout | Lock timeout |
| --- | --- | --- |
| `anon` | 3 seconds | No role override |
| `authenticated` | 8 seconds | No role override |
| `authenticator` | 8 seconds | 8 seconds |
| `service_role` | 3 seconds | 250 milliseconds |

The sampled idle-transaction timeout is zero.
The report's own statement and lock limits do not represent role defaults.

## Earlier interruption evidence

The earlier shared server starts at 07:18:55.937843 UTC.
At 07:20:24.682393 UTC, a replacement server starts under the same assigned project and port.
The replacement contains 609 migrations through `20261118000100`, which is absent from this checkout.
Its league, member, user, and player-stat tables are empty, and cron is enabled again.
The audit stops database work after detecting this replacement.

The user later assigns the exclusive `pt4bafabledb` project and `574xx` ports.
The resumed audit preserves 50 screen output hashes across both delivered migrations.
The expanded walk also covers player search: 52 calls across all 26 stable screen functions pass.
A missing-function negative control fails as required.
The replacement instance remains untouched after detection.
Raw backup copies and generated local credentials are removed from this task's checkout during cleanup.

## Daily queries

Run these queries through the private operator connection.
The report command includes the same catalog and counter sources.

### Dead rows and update pressure

These estimates identify tables that need inspection.
They do not measure exact free space or index bloat.

```sql
SELECT schemaname,relname,n_live_tup,n_dead_tup,
  round(100.0*n_dead_tup/greatest(n_live_tup+n_dead_tup,1),2) AS dead_percent,
  n_tup_upd,n_tup_hot_upd,
  round(100.0*n_tup_hot_upd/greatest(n_tup_upd,1),2) AS hot_percent,
  last_autovacuum,last_autoanalyze,
  pg_table_size(relid) AS table_bytes,pg_indexes_size(relid) AS index_bytes
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC,pg_total_relation_size(relid) DESC;
```

### Unused-index candidates

Keep uniqueness, foreign-key access, rare jobs, and the statistics reset time in the review.
This query reports candidates; it does not generate drop statements.

```sql
SELECT s.schemaname,s.relname,s.indexrelname,s.idx_scan,
  pg_relation_size(s.indexrelid) AS bytes,pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid=s.indexrelid
WHERE s.idx_scan=0 AND NOT i.indisunique AND NOT i.indisprimary
  AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=s.indexrelid)
ORDER BY pg_relation_size(s.indexrelid) DESC;

SELECT stats_reset FROM pg_stat_database WHERE datname=current_database();
```

### Statements and buffer cost

Compare counter differences across the same workload.
Buffer hits measure logical page access; they are not physical disk reads.
The stored statement ID supports private investigation without publishing query text.

```sql
SELECT queryid,toplevel,calls,rows,total_exec_time,mean_exec_time,
  shared_blks_hit,shared_blks_read,shared_blks_dirtied,shared_blks_written,
  temp_blks_read,temp_blks_written,wal_bytes,
  round((shared_blks_hit+shared_blks_read)::numeric/greatest(calls,1),2) AS buffers_per_call
FROM extensions.pg_stat_statements
WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
ORDER BY total_exec_time DESC;
```

### Locks and long transactions

```sql
SELECT pid,usename,state,wait_event_type,wait_event,
  timeofday()::timestamptz-xact_start AS transaction_age
FROM pg_stat_activity
WHERE datname=current_database() AND pid<>pg_backend_pid()
  AND (wait_event_type='Lock' OR state='idle in transaction'
    OR xact_start<timeofday()::timestamptz-interval '30 seconds')
ORDER BY xact_start;
```

### Retention coverage

```sql
SELECT r.relation_name,r.retention_rule,r.worker,
  s.last_checked_at,s.last_pruned_at,s.last_rows_pruned,s.rows_pruned,s.last_error
FROM private.retention_rules r
LEFT JOIN private.retention_status s USING(relation_name)
ORDER BY s.last_checked_at NULLS FIRST,r.run_order,r.relation_name;

SELECT n.nspname,c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN private.retention_rules r ON r.relation_name=n.nspname||'.'||c.relname
WHERE c.relkind IN ('r','p','m')
  AND n.nspname IN ('public','private','analytics','auth','storage','cron','net')
  AND r.relation_name IS NULL;
```

## Screen-plan collection

Use the local `supabase_admin` connection for nested plan capture.
The ordinary `postgres` role refuses `LOAD 'auto_explain'` on this stack.

```sh
node scripts/db-health/index.mjs --walk ../evidence/db-walk
```

The collector records outer `EXPLAIN (ANALYZE, BUFFERS)` plans, nested plans, payload hashes, and payload sizes.
It calls stable screen functions as two authenticated members and rolls back its transaction.
Trade preview validation takes row locks, so the collector cannot use a read-only transaction.
It fails if a screen call fails or the backup has no members.
The collector completes 52 populated calls across all 26 stable screen functions on the exclusive restored stack.
It rejects any stable screen function that has no recorded call.
The earlier 50 calls retain identical hashes after the two added search calls.
The first reviewed trace contains 6,516 plans across 211 distinct statements.
The expanded trace contains 8,153 plans across 253 distinct statements.
Its largest observed sequential scan reads 2,618 player rows.
The statistics table uses indexed access in this screen sample.
Later traces include the authorized trade-preview paths.
It does not establish cold, warm, offline, empty, or live browser coverage.

## Current delivery gates

| Item | Evidence and remaining work |
| --- | --- |
| 1. Index audit | All 52 screen hashes match after the roster-index removal and pending-invocation index replacement. Full coverage of the earlier 1,644-statement gap remains open. |
| 2. Hot tables and partitions | Stats and four log tables are partitioned. The rejected outbox partition is reverted. Stats read and storage overhead still require review. |
| 3. Write amplification | Provider, lineup, calendar, and forecast gates have measured checks. The inventory has 521 functions and 684 write candidates. Remaining paths need review. |
| 4. Read path | Incremental player totals and stored screen aggregates exist. The inventory finds 292 SQL star candidates. Keyset pagination and incremental standings remain open. |
| 5. Statement limits | Role limits and the live idle-timeout check pass. The current replay and phase-specific limit review remain open. |
| 6. Retention | Seven retention suites pass on restored data. The catalog has 238 policies and 22 workers. Managed Auth and Storage cleanup remains unverified. |
| 7. Capacity | The earlier corrected layout has a numeric season forecast. The new logging-off replay must refresh it after completion. Hosted capacity remains unverified. |
| 8. Health | The guarded report and daily queries run on the restored backup. The post-merge baseline appears below. |

The release 2.6.1 merge applies and attests 647 migrations through `20261125000500`.
The five repaired wake tests and seven release SQL suites pass.
The corrected clock replay completes with statement logging off.

## Post-merge baseline

Capture: October 28, 2026, at 13:19:18.698 UTC.
This sample follows verification work; it is not the replay's starting growth snapshot.
It uses `pg_stat_statements.track=all` and contains no waiting sessions or idle transactions.
No Final game lacks stat rows.

| Measure | Value |
| --- | ---: |
| Database size | 238,677,139 bytes |
| Physical table entries | 206 |
| Index entries | 927 |
| Statement entries | 1,218 |
| Stats rows after analyze | 245,097 |
| Stats allocation, including partitions and indexes | 142,983,168 bytes |
| Invocation allocation, including partitions and indexes | 5,005,312 bytes |
| Outbox rows after analyze | 257 |
| Outbox allocation | 434,176 bytes |

Partition allocation includes empty leaves and catalog overhead.
These totals do not show a storage saving for stats.
All four application roles have a sixty-second idle-transaction timeout.
The service role has a three-second statement limit and a 250-millisecond lock limit.
Anonymous reads have a three-second statement limit; authenticated reads have eight seconds.
Both read roles and the authenticator have a 500-millisecond lock limit.
The report connection's own fifteen-second statement limit remains separate.

## Earlier two-day workload failure

The prepared window covers October 29–30, 2026, with 13 scheduled games.
Historical same-team box scores and live events supply explicitly synthetic mappings.
The simulator keeps the real dispatch cadence and its existing scoring, trade, waiver, and Realtime checks.
The installed worker inventory now includes forecast and refresh workers.

An earlier profiled run stops during startup, before either simulated day completes.
One player-sync response reports six ambiguous identities and an unavailable Sleeper identity input.
Each of these identities has duplicate-name records in the restored backup.
The identity guard refuses to select a row without stronger evidence.
A later player-sync request exceeds the existing 30-second HTTP deadline.
These failures do not prove that production inputs or unprofiled workers have the same defect.
The resulting plans are diagnostic samples, not complete workload coverage.

The retry check follows the existing queue attempt limit for failed worker responses.
An exhausted or unowned failure stops the replay.
Acceptance also requires every deferred item to finish successfully; persistent data errors remain fatal.
Cleanup records both errors if clock restoration also fails.
The operator clock-restoration phase uses a five-second lock limit and a 60-second statement limit.
These limits do not change application role settings.

The failed run cannot justify unused-index drops, capacity claims, or new phase limits.
The restored starting data and native database clock are verified after the failed run.
Focused verification passes 629 source and attestation tests, 12 simulator tests, and four database recipes.
The complete quality command passes.

## Partition constraints

Four requested targets still have a primary key without a time or season column.
Beacons and request receipts now use monthly partitions and preserve global ID uniqueness with guarded writes.
Player statistics also enforce global uniqueness on `(player_id, game_id)`.
Request receipts enforce uniqueness on `request_id`.
The notification outbox also enforces global uniqueness on `dedupe_key`.
No incoming foreign key references these six targets in the restored catalog.

Partition conversion must preserve these identity rules and their conflict behavior.
The direct notification writer uses `ON CONFLICT(dedupe_key)` outside the granted edit paths.
Its change needs scope approval before a monthly outbox conversion can proceed.
The remaining conversions still require migration, replay, retention, and rollback proofs.

## Resumed audit results

The identity index handles the 500-player sample in 186.878 ms, compared with 2,215.504 ms before the change.
The returned hash and all 52 screen hashes match.
Six reviewed provider links now resolve without adding or deleting players.
The bounded simulation uses current backup identities and retained projections with explicit synthetic provenance.

The restored schedule contains 1,200 games and exactly 80 appearances per team.
The corrected calendar keeps that schedule partial and preserves its recorded week numbers.
A complete schedule requires 82 appearances per team; its multiple-gap guard remains active.

Migration `20261119000600` skips unchanged player metadata writes while retaining listing freshness updates.
The three-player replay writes zero player rows, compared with three before the change.
All 52 screen hashes remain identical.
Migration `20261119000700` expires dead work after 90 days, with a 5,000-row batch limit.
Pending and retryable work remain protected.

Migration `20261119000800` sets application idle-transaction limits to 60 seconds.
Interactive requests retain eight-second statement limits; anonymous and worker requests retain three-second limits.
Lock limits are 500 milliseconds, except the worker role keeps 250 milliseconds.
A real application-role connection closes with an idle-transaction timeout after the 60-second boundary.

The report now includes `missingFinalStats`, with a count and oldest affected date.
The restored baseline has zero Final games without stat rows.
The POR at LAL row is Scheduled in this backup; a rolled-back test reproduces its reported Final-without-stats state.
The daily reconciliation test passes eight scheduling, deduplication, dispatch, and continuation checks.

```sql
SELECT game.id,game.nba_game_id,game.game_date,game.home_team,game.away_team
FROM public.nba_games game
WHERE game.status='Final'
  AND NOT EXISTS(SELECT 1 FROM public.player_game_stats stats WHERE stats.game_id=game.id)
ORDER BY game.game_date,game.id;

SELECT id,status,attempts,due_at,completed_at,last_error
FROM private.work_items
WHERE kind='missing-final-stats'
ORDER BY id DESC LIMIT 20;
```

The local operator command also supports `--sources`, `--walk`, and `--compare`.
It uses the same loopback guard and read-only report as the direct Node entry point.
It rejects unknown commands and foreign database hosts before opening a connection.

## Statement logging comparison

Three paired 500-player calls use the same rows and return the same hash.
Their median execution times are 168.687 ms without nested statement logging and 602.308 ms with logging.
This 3.57-times ratio applies to that controlled database call, not to the application as a whole.

Earlier full-workload attempts stop during startup.
The unlogged attempt takes 27.592 seconds and exhausts retries on calendar publication.
The logged attempt takes 56.229 seconds and exhausts the player-sync statement budget.
Neither completes a simulated day, so these durations do not establish a whole-workload overhead ratio.

Concurrent text-log records contain interleaved JSON and cannot prove complete plan coverage.
The parser now accepts PostgreSQL indentation and refuses malformed or incomplete records.
The private stack uses PostgreSQL's structured JSON collector.
Two concurrent test sessions produce two complete, independently parsed plan records.

```sh
node scripts/db-health/plan-summary.mjs --jsonlog ../evidence/server-plans.jsonl
```

The complete two-day trace still needs collection from these structured server logs.


## Partition and replay checks

Migration `20261119001300` partitions beacons and request receipts by month.
Their restored row hashes and all 52 screen hashes stay identical.
Concurrent inserts cannot reuse a request ID in another month.
A disabled-guard control admits the duplicate and proves the check can fail.
The tests also cover beacon IDs, moved dates, future months, expired partition drops, and child-table permissions.
The migration passes repeat application and catalog attestation.

The current migration history contains 623 entries.
The player-sync merge preserves lock-free stat identity reads and bounded source batches.
A focused overlap test ingests two stat rows while player linking holds its transaction.
The daily Final-game reconciliation remains enabled.
The two-day acceptance receipt and complete statement-plan inventory remain outstanding.

Run `ANALYZE` after resetting table statistics before using row estimates as a baseline.
A statistics reset can temporarily show zero live rows in a populated table.
The report does not treat those estimates as an exact count or a bloat measurement.

## Current partition coverage

Migration `20261119001500` adds monthly event and invocation partitions.
Beacons and request receipts already use monthly partitions.
That capture predates the player-stat and notification-outbox partitions.
The four converted parents preserve global identifiers and their existing access rules.
Invocation retention preserves each function's newest success and failure.
League event retention keeps two years.
All 52 screen calls pass after the conversion.
All 636 migrations are attested.

## Index review across partitions

Run `supabase/sql/index-audit.sql` after the complete workload.
The report adds child scan counts under each parent index.
It compares key columns, operator classes, collations, sort options, and predicates before naming a covering index.
The live catalog check finds `idx_lineups_scoring_path` covering `idx_lineups_league_week`.
A zero count during an unfinished workload does not authorize a drop.

## Public read counters

Public read counters retain seven days.
The daily worker and request cleanup each delete at most 5000 rows per call.
The policy inventory covers every current public, private, and analytics relation.
Child partition entries use full schema names, including default partitions.
Bounded state entries document their parent lifetime and replacement rule.

## Baseline for the current unlogged window

Capture: October 28, 2026, at 09:52:46.161 UTC, after preparation and before the measured two-day window.
The simulated database time is October 29 at 14:03:12 UTC.
This snapshot includes the restored backup, release 2.5, migrations through `20261119001700`, and replay preparation.
It is not the completed workload report.

| Measure | Value |
| --- | ---: |
| Database bytes | 190,966,931 |
| Relations, including child partitions | 133 |
| Logical table roots | 116 |
| Physical indexes | 438 |
| Statement entries | 1,228 |
| Waiting sessions | 0 |
| Idle transactions | 0 |
| Statement tracking | all |

Table totals include each partition's heap and indexes.
Row counts are estimates.

| Relation | Estimated rows | Heap and TOAST bytes | Index bytes | Total bytes |
| --- | ---: | ---: | ---: | ---: |
| `public.player_game_stats` | 245,518 | 53,510,144 | 59,932,672 | 113,442,816 |
| `public.edge_invocations` | 5,754 | 1,687,552 | 2,990,080 | 4,677,632 |
| `public.league_events` | 255 | 188,416 | 303,104 | 491,520 |
| `public.notification_outbox` | 441 | 360,448 | 270,336 | 630,784 |
| `public.perf_beacons` | 0 | 32,768 | 98,304 | 131,072 |
| `private.request_receipts` | 35 | 114,688 | 81,920 | 196,608 |
| `analytics.player_season_totals` | 3,870 | 1,736,704 | 450,560 | 2,187,264 |
| `public.weekly_lineups` | 7,368 | 1,597,440 | 3,923,968 | 5,521,408 |

All four application roles have a 60-second idle-transaction limit.
Statement limits are three seconds for anonymous and worker requests, and eight seconds for authenticated requests and the connection role.
Lock limits are 250 milliseconds for workers and 500 milliseconds for the other three roles.
The report connection's own limits do not replace these role settings.

## Completed two-day baseline

The unlogged October 29–30 window passes thirteen games and 4,154 live-score checks.
Both final-box-score checks and scoring checks pass. The source is `0c4aa955` on the restored private stack.
The measured capture interval is 4,120.18 seconds; preparation is excluded.

| Measure | Baseline result |
| --- | ---: |
| Database bytes, before / after | 190,966,931 / 196,758,675 |
| New stat rows | 450 |
| Total stat rows after the window | 245,968 |
| Season games with stat rows | 77 |
| Final games without rows | 4 |
| CPU cores, mean / p95 / maximum | 0.73 / 1.30 / 2.42 |
| Database memory maximum | 913,833,984 bytes |
| Connections maximum | 25 |
| Samples with lock waits | 0 of 1,324 |
| Tracked top-level statement calls | 1,189,816 |
| Missing statement entries across snapshots | 0 |
| WAL bytes | 315,303,049 |
| Buffer bytes read | 25,354,240 |
| Temporary blocks written | 0 |
| `log_statement` | `none` |
| `log_min_duration_statement` | `-1` |

At that run's end, four Final games lack stat rows.
The corrective daily reconciliation schedule requires a new workload receipt after its migration.
Stats and outbox partition checks separately preserve all 52 screen hashes, source rows, aggregate totals, and revision state.
The new layout has thirteen passing SQL suites and passing native concurrency, isolation, and checkpoint checks.
Its complete two-day workload remains pending.

Use `scripts/db-health/statement-coverage.mjs` with matching before/after snapshots and `backend-plans.jsonl.gz`.
It preserves full query identifiers and reports missing plans. Captured plans still require review.
The completed timing run does not provide all-statement plan coverage because plan logging is off.
Index removals and the remaining read/write review stay pending.

## Baseline after partition migration

Capture: October 28 at 11:05:52.114 UTC, after restoring the pre-window data and applying the three corrective migrations.
All 641 migrations are attested. The live function catalog check passes.

| Measure | Value |
| --- | ---: |
| Database bytes | 202,091,667 |
| Relations including partitions | 209 |
| Physical indexes | 943 |
| Stats rows | 245,097 |
| Stats parent and children, total bytes | 117,006,336 |
| Stats child tables, including default | 70 |
| Outbox parent and children, total bytes | 507,904 |
| Missing Final games | 0 |
| Waiting sessions / idle transactions | 0 / 0 |

This restored baseline differs from the completed two-day endpoint above.
A new unlogged run must measure growth and latency on the corrected layout.

## Outbox regression correction

Migration `20261125000400` restores the ordinary outbox table and native global unique keys.
The rejected partition layout remains recorded above for comparison.
The three row guards caused the insert regression.
Ten shuffled trials show 38.530 ms with guards and 2.331 ms without them.
Native unpartitioned inserts take 1.635 ms in that control.
Disabling guards is a diagnostic only. The delivered table enforces all three identities with native unique indexes.

The replacement preserves all rows, permissions, policies, and both original triggers.
Seven SQL suites pass. Concurrent uniqueness checks pass for stats and notifications.
Repeatable-read checks pass. All 52 screen results and aggregate hashes match.
All 642 migrations are attested. The live function catalog passes.

| Matched restored-data probe | Rejected layout | Corrected layout |
| --- | ---: | ---: |
| Insert 100 messages | 32.222 ms | 1.291 ms |
| Insert shared buffers | 5,788 | 1,201 |
| Queue read | 0.088 ms | 0.059 ms |
| Queue shared buffers | 22 | 19 |
| Replay 100 messages | 0.670 ms | 0.322 ms |

Statement logging is off. Each insert produces the same 100 logical messages.
The original pre-partition insert took 1.221 ms, and its queue read used 94 buffers.
The corrected insert is 0.070 ms above that original single probe.
The queue uses 75 fewer buffers than that original probe.
These are controlled query measurements, not workload throughput claims.
Repeated probes vary with cache state and space left by rolled-back inserts.
The paired plans and causal controls remain in the private evidence folder.

SQL producers again use batched native `ON CONFLICT` inserts.
The rookie notification RPC keeps its bounded enqueue helper with one native insert.
Outbox retention deletes at most 5,000 terminal messages older than sixty days.
Pending messages stay. Retention no longer requires partition-wide identity checks.
Insert vacuum settings use a fifty-row threshold and a 0.02 scale factor.
The complete corrected-layout replay remains required.

After probe cleanup, the October 28 11:38:35 UTC baseline has 224,660,627 database bytes.
It contains 205 relations and 925 indexes, including stats partitions.
The outbox has 257 rows and 294,912 allocated bytes, with zero estimated dead rows.
No Final game lacks stats. No session waits on a lock or remains idle in a transaction.
This allocation includes catalog space from the audit; it is not the replay's starting snapshot.

## Review large plan captures

Keep the complete compressed backend log as evidence.
This optional command streams that log and retains the highest buffer and time samples for each statement and plan shape.
It preserves different predicates and exact 64-bit query identifiers.
It fails when captured plans lack identifiers. Utility log records remain in the raw evidence.

```sh
node scripts/db-health/compact-plans.mjs ../backend-plans.jsonl.gz ../review-plans.jsonl.gz
node scripts/db-health/statement-coverage.mjs ../growth-before.json ../growth-after.json ../backend-plans.jsonl.gz
```

A synthetic 100,000-record capture uses about 72 MB peak memory through compaction, versus 563 MB with whole-file parsing.
The paired runs take 1.37–1.39 seconds through compaction and 0.91–0.92 seconds through whole-file parsing.
The original parser remains available for smaller files.
These measurements describe log processing on the Mac, not database latency.
Thirteen focused plan tests pass, including missing identifiers, distinct predicates, malformed input, and raw-file preservation.
Compaction does not complete the statement review. Check every retained plan and resolve every missing statement.

The release 2.6.1 merge is checked against 647 applied migrations.
Type generation and its equality check use `127.0.0.1:57422` on the private mini.
This CLI version redirects its type container to an unavailable `db` hostname.
The checked workaround runs the existing postgres-meta v0.97.0 image code natively.
It uses the project's scoped database URL and the public and GraphQL schemas.
It downloads no packages and starts no network listener.
The usual generation script still applies RPC nullability overrides and checks the output.

## Reviewed maintenance bounds

All 22 retention functions declare a three-second statement limit and a 100-millisecond lock limit.
The scheduler checks its two-second elapsed budget between workers.
This catalog review does not prove a hard two-second limit for the complete call.

| Data | Retention | Maximum work per call |
| --- | --- | --- |
| Auth sessions | Expired seven days; inactive ninety days | 500 sessions |
| Auth refresh tokens | Expired or revoked seven days; inactive ninety days | Two 5,000-row batches |
| Cron run history | Twenty-four hours | 5,000 rows; matching live backends remain |
| Edge invocations | Success seven days; failure thirty days | Twelve partitions plus bounded 5,000-row tails |
| League events | Two years | Twelve partitions plus 5,000 boundary rows |
| League change hints | Deleted leagues | 5,000 rows |
| Lineup dispatches and members | Terminal thirty days | 5,000 rows per worker |
| Matchup forecast queue | Ended or voided seven days | 5,000 rows |
| Matchup forecasts | Invalid and ended seven days | 5,000 rows |
| Notification outbox | Terminal sixty days | 5,000 rows; pending messages remain |
| Performance beacons | Thirty days | Twelve partitions plus 5,000 boundary rows |
| HTTP responses | Six hours | 5,000 rows; unreconciled requests remain |
| Player game stats | Durable scoring history | Partition maintenance; no age deletion |
| Projection runs | Before the current week | 200 parents and 5,000 child rows |
| Public read counters | Seven days | 5,000 rows |
| Request receipts | Seven days | Twelve partitions plus 5,000 boundary rows |
| Sleeper projection rows | Before the current week | 5,000 rows |
| Sync jobs | Completed thirty days | 5,000 rows; resumable jobs remain |
| Sync runs | Success seven days; failure thirty days | Bounded 5,000-row batches; latest outcomes remain |
| Trade estimate quotes | Expired seven days | 5,000 rows; referenced quotes remain |
| Work items | Success seven days; dead ninety days | 5,000 rows; retriable work remains |

Projection child deletion uses 500-row chunks within its 5,000-row budget.
Partition drops count rows first, so their cost still depends on partition size.
The older `prune_unbounded_history` entry point has larger limits and still needs a caller and retention review.

## Completed-window endpoint

Capture: 2026-10-28T14:26:45.192Z. Statement logging is off.
Both days and the final worker drain pass.
The endpoint records 241,216,659 database bytes, 205 table entries, and 925 index entries.
It records 0 waiting sessions and 0 idle transactions.
Final games without stats: 0.
The resource sampler records 1176 samples; 0 contain lock waits.
The [capacity report](db-capacity.md#measured-boundary) gives current allocation measurements and their limits.
Full statement-plan coverage and unused-index decisions remain unverified.

## Plan coverage after the completed replay

The streaming reader finds 64 backend log records and zero captured plans in the timing log.
This is expected because timing runs disable statement logging.
The counter comparison contains 1,681 executed statements: 37 utility statements and 1,644 missing non-utility plans.
The coverage check fails explicitly. A separate logged workload is still required.

The subsequent screen walk passes all 52 calls across 26 stable views.
It records 13,749 nested plans across 265 distinct query texts.
These screen plans do not replace the missing two-day statement plans.
They remain separate evidence for the complete plan review.

The completed timing snapshot contains 254 zero-scan nonunique index entries totaling 23,814,144 bytes.
Both lineup prefix indexes have zero scans in that snapshot.
Index decisions must also include the screen walk and partition-child usage.
No index is removed without before/after plans and a measured gain.

## Release 2.6.2 check results

The release merge applies and attests 648 migrations through `20261128000100`.
The full Vitest run records 4,217 passes, zero failures, and 39 skipped tests.
All 335 season tests pass.
The release-order test accepts the documented supplied-head wording and still checks missing rollout evidence.
The release notes identify the private migration head and keep database-before-Edge ordering.
The live function catalog and loopback generated-type checks pass after the merge.
The logged workload remains separate from the completed timing baseline.
Full statement review, index removals, and remaining read/write/timeout/retention changes are still open.

## Index candidates across partition children

Run `scripts/db-health/index-candidates.sql` through the private database connection.
The query includes child-index scans and storage in each parent total.
It compares B-tree key prefixes, sort options, operator classes, collations, included columns, and predicates.
It excludes invalid indexes, constraints, primary keys, unique candidates, and replica-identity indexes.
Its output is a review list, not permission to drop indexes.

The post-merge probe returns 23 candidate/replacement pairs.
The largest candidate is `idx_lineups_league_week`, at 98,304 bytes.
The season-week candidate has 1,392 scans and must not be treated as unused.
Recheck the counters after the complete logged workload before making any removal.

## Read-path review still requiring changes

The current readers have these source limits and ordering rules.
These are source findings, not completed pagination changes.

| Reader | Maximum returned rows | Current page method | Required cursor fields |
| --- | ---: | --- | --- |
| League activity | 100 | Offset over transactions and activity | Occurrence time, ID, source kind |
| Dynasty inputs | 1,000 | Offset before the final enrichment order | Stable ranking value, name, ID |
| League projections | 1,000 | Offset after projection calculation | Fantasy points, name, ID, null state |
| Player search | 100 | Offset over computed page rank | Selected sort values and ID |
| Public resources | 50 | SQL offset or array ordinal slicing | Resource-specific order and ID |
| Player game section | 101, including the extra-row probe | Increasing first-page limit | Game date and stat ID |

The dynasty reader selects a ranked page before applying its final output order.
A cursor implementation must use the same order for selection and output.
Projection cursors must preserve null ordering and equal-score ties.
Activity cursors need a source discriminator because the feed combines two independent ID spaces.
The player game section currently fetches its first page again when its requested limit grows.

Player season totals use transition-table deltas.
Matchup totals use stored matchup values with version and value-change guards.
Standings refreshes still aggregate finalized matchups for every member in the affected league season.
That standings path does not yet meet the requested incremental-maintenance requirement.
The source review therefore leaves incremental team/week and standings maintenance open.

The plan compactor preserves output expressions and function contexts for anonymous plans.
Those plans remain marked unidentified and require review.
A matching node shape alone cannot identify their work.

Transaction ages use the server's real clock, even when the replay freezes business time.
A live regression check compares the report with host time and database transaction start times.
The old expression reports 95,654 seconds for a transaction measured at about twelve seconds by the host.
The corrected expression passes the host-time check during replay.

## Release 2.6.2 logged replay and claim fix

The separate logged replay stops on day one, before tipoff, at simulated October 29, 22:03 UTC.
Notification claiming exceeds the service role's three-second statement limit.
This is an incomplete replay, not a replacement for the completed logging-off receipt.

The streaming reader processes 3,500,386 plans from 3,500,409 log records.
It retains 2,672 representatives across 709 query identifiers and 2,257 plan shapes.
There are 9,231 anonymous plans without identifiers.
The raw compressed log uses 260,759,927 bytes.
The retained compressed review file uses 4,519,724 bytes.
These plans cover the failed interval, not both simulated days.
The earlier 1,644-statement coverage gap remains an open acceptance gate.

The failing queue contains repeated lineup notifications for the same member and league.
The old claim recomputes current lineup candidates for each notification.
Migration `20261125000600` computes those candidates once per distinct scope within the bounded claim.
The claim limit, lease rules, preferences, stale checks, and final delivery admission remain active.

| Matched claim probe | Before | After |
| --- | ---: | ---: |
| Median execution, logging off, two rounds | 3,181.390 ms | 452.023 ms |
| Median buffers, two rounds | 394,375 | 73,469 |
| Generic-plan median, logging off, three rounds | 2,942.561 ms | 426.838 ms |
| Generic-plan median, logging on, three rounds | 18,909.782 ms | 2,507.498 ms |
| Custom-plan median, logging off, three rounds | 2,709.555 ms | 424.982 ms |
| Custom-plan median, logging on, three rounds | 18,776.646 ms | 2,748.186 ms |

All probes use the same failed-replay state and return identical hashes.
These particular pending notifications are stale, so their delivery results are empty.
A separate fixture verifies 160 valid claims and 40 stale suppressions.
It also checks malformed identifiers, noncanonical identifiers, and retained claim leases.
The batching guard fails before the fix and passes afterward.
The full replay still needs to confirm the fix across both days.

The before/after queue-state hashes also match after claim execution.
All 52 stable screen calls retain identical hashes across the claim change.
The claim, bounded-batch, staleness, preference, wake, pause, and deleted-league SQL suites pass.
The pause fixture now supplies its commissioner's identity, as required by the current draft-order authorization.

## Diagnostic endpoint after the failed logged run

Capture: October 28, 2026, at 16:49:41 UTC.
Statement logging is disabled for the report connection.
This sample includes regression probes and is excluded from growth calculations.

| Measure | Value |
| --- | ---: |
| Applied migrations | 649 |
| Database bytes | 238,013,587 |
| Physical table entries | 205 |
| Index entries | 925 |
| Statement entries | 4,033 |
| Waiting sessions | 0 |
| Idle transactions | 0 |
| Final games without stats | 0 |
| Outbox estimated rows | 536 |
| Outbox total bytes | 1,433,600 |
| Outbox updates / HOT updates | 4,747 / 419 |
| Player season total updates / HOT updates | 280 / 174 |

Outbox HOT updates account for 8.83 percent of recorded updates.
Player season total HOT updates account for 62.14 percent.
Rollback tests also contribute to these counters, so they are diagnostic values rather than workload-only rates.


## Streaming statement coverage

The coverage command now reads raw JSON log lines incrementally, including gzip input.
It retains identifier counts rather than the entire decompressed log.
It preserves signed 64-bit identifiers and reports missing plans as failures.
It does not mark captured plans as reviewed.

A matched 100,000-plan probe uses 61,767,680 resident bytes with streaming and 422,199,296 bytes with whole-file parsing.
Both readers count all 100,000 plans for the same statement.
The streaming heap sample is 6,302,328 bytes; the earlier reader uses 127,483,072 bytes.
These are operator memory measurements, not database capacity measurements.


## Isolated index measurements

These probes use a separate restored database on the private stack.
They do not remove indexes from the running replay.
Each row compares three prefix-read probes with identical result hashes.
Allocated bytes differ from the earlier snapshot because restoration rebuilds each index.

| Candidate | Before buffers | Without index buffers | Index bytes |
| --- | ---: | ---: | ---: |
| `idx_lineups_league_week` | 95 | 97 | 73,728 |
| `idx_weekly_lineups_league_season_id` | 172 | 172 | 73,728 |
| `idx_league_members_user` | 14 | 14 | 16,384 |
| `idx_league_members_league` | 16 | 16 | 16,384 |
| `idx_slot_templates_league` | 29 | 29 | 16,384 |
| `idx_roster_players_member` | 11 | 11 | 16,384 |
| `idx_roster_players_league_season` | 11 | 11 | 16,384 |
| `idx_matchups_league_season_week` | 12 | 12 | 16,384 |
| `idx_draft_picks_league_year` | 8 | 8 | 16,384 |
| `idx_waiver_priorities_league_season` | 4 | 4 | 16,384 |
| `idx_waiver_claims_member` | 17 | 17 | 16,384 |
| `idx_transactions_player` | 7 | 7 | 16,384 |
| `idx_waiver_claims_league_season` | 17 | 17 | 16,384 |
| `idx_standings_league_season_id` | 10 | 10 | 16,384 |

Two remaining candidates have empty tables and no useful read measurement.
The used player-team and season-week indexes are excluded from removal candidates.
The lineup league/week removal increases read buffers from 95 to 97, so it is rejected.
Other equal-buffer results establish no read-speed improvement.

Five paired 100-row lineup insert probes isolate index maintenance with triggers disabled.
Removing the league/week index reduces 115,866 WAL bytes to 106,266, but its read regression remains.
Removing the season-only index reduces 115,866 WAL bytes to 108,666 and 2,344 buffers to 2,121.
Its measured insertion median rises from 1.303 to 1.449 ms; that result does not justify a performance claim.
These prefix probes alone do not justify a removal.
Full workload use, foreign-key access, and repeated timing still govern the decision.


## Forecast queue write gate

Migration `20261125000700` skips unchanged invalidations within one transaction.
A new transaction still increments the revision.
A clean or deferred queue row still becomes ready.
The regression test also preserves an existing lease so stale completion remains detectable.

Three paired 100-call probes use the same restored benchmark data and keep logging off.
Median execution falls from 8.068 to 5.839 ms.
Buffers fall from 2,131 to 1,301; WAL falls from 17,860 to 54 bytes.
Repeated queue updates fall from 100 to zero, with identical logical rows.
The gate, cache, and worker suites pass 36 checks.
The separate restored database applies and attests 650 migrations.
The detached replay keeps its original 649-migration schema until it finishes.


The running stack has 238 registered relation policies and 22 distinct retention workers.
Its catalog audit finds no unregistered application, Auth, Storage, cron, or network table.
Partition creation adds child policies, so the count changes as the calendar advances.
Registration alone does not prove that each worker meets its deletion and time budgets.


Seven retention suites now pass on the restored test database.
The daily suite verifies 70 conditions; the worker-bound suite verifies 46.
They test exact deletion counts, a 5,000-row continuation, pending-row preservation, and cancellation before another batch.
Fixtures now isolate their expired projection and invocation rows from the restored backlog.
The legacy history fixture uses a separate source name and the current dispatcher entry.
The beacon fixture loads under replica mode, then restores normal triggers before testing retention.
This avoids exhausting transaction locks while creating 12,000 fixture rows.
The separate partition-identity tests remain responsible for identity enforcement.
Managed Auth and Storage lifecycle labels still require independent cleanup verification.


## Measured roster index removal

A larger ten-pair probe supports removing `idx_roster_players_member`.
The existing taxi and member/season indexes retain its leading member key.
The completed replay before removal reports zero uses.
The replacement indexes preserve member lookups and foreign-key access.

For 1,000 deterministic roster inserts, median time falls from 13.665 to 12.290 ms.
Buffers fall from 16,410 to 15,392; WAL falls from 884,456 to 811,816 bytes.
These probes disable triggers equally in both cases to isolate index maintenance.
They do not measure complete request latency.
The prefix read changes from 0.347 to 0.362 ms, stays at eleven buffers, and returns the same hash.
All 52 screen calls retain identical hashes after removal.
Migration `20261125000800` removes the redundant index and saves 16,384 bytes in the restored sample.
The final layout includes this removal.

The subsequent completed control reports 21 prefix-replacement pairs across seventeen other indexes.
Six candidates record workload reads and remain installed.
Eleven candidates record zero reads; none has another measured net gain that supports removal.
The earlier league/week removal increases read buffers, and the season-only removal increases insertion time.
Both remain installed. Empty draft tables do not supply useful timing evidence.
Zero scans alone do not justify another removal.


## Rejected incremental standings prototype

A tested prototype keeps finalized regular-season totals through transition-table deltas.
Fourteen correction, void, deletion, and truncation checks pass; concurrent updates retain both changes.
Its 100-refresh probe improves from 15.199 to 12.539 ms on the unchanged backup.
A separate deterministic finalized-history fixture improves from 29.871 to 15.705 ms.
However, 100 paired live updates and refreshes rise from 138.427 to 146.318 ms without finalized history.
The equivalent finalized-history scenario falls from 144.086 to 135.434 ms.
The early-season regression rejects this implementation; its schema and code are removed from the benchmark.
Incremental standings and team/week maintenance remain open.


## Pending invocation access

The plan report now counts rows rejected by filters and index rechecks.
One captured idle-dispatch scan returns no rows after examining 5,889 completed invocations.
Migration `20261125000900` replaces the unreconciled-only index with a partial index for either unreconciled or running work.
It retains the queue-time leading key and includes the invocation ID.

Three paired probes reduce the idle check from 195 to eleven buffers and 0.566 to 0.044 ms.
The populated pending check falls from 169 to four buffers and 0.583 to 0.036 ms.
A 100-invocation insert probe measures 21.518 ms before and 20.534 ms after.
Its buffers rise from 7,879 to 7,932; this small write cost accompanies the measured read reduction.
The query results match in both pending states.
A failing-before plan-budget test also checks unreconciled, running, and completed transitions.


All 52 screen hashes also match across the pending-index replacement.
Five invocation suites pass, including the new four-condition plan test.
The correlation fixture now uses the current work queue and checks canonical runs, backoff, and stale callbacks.
It no longer calls the removed cron-dispatch RPC or reads the removed state table.

## Current replay diagnostic snapshot

Capture: October 28, 2026, at 17:49:23 UTC.
The 649-migration replay has completed day one and is processing day two.
Statement logging is off, and `pg_stat_statements.track` remains `all`.
This is an intermediate diagnostic snapshot, not the final growth measurement.

| Measure | Value |
| --- | ---: |
| Database bytes | 237,702,291 |
| Table entries | 205 |
| Index entries | 925 |
| Statement entries | 1,701 |
| Waiting sessions | 0 |
| Idle transactions | 0 |
| Final games without stats | 0 |
| Outbox estimated live / dead rows | 571 / 45 |
| Outbox updates / HOT updates | 403 / 14 |
| Player total updates / HOT updates | 6,424 / 5,813 |
| Roster member-only index scans | 0 |

Outbox HOT updates account for 3.47 percent of its updates.
Player total HOT updates account for 90.49 percent.
These counters start with the fresh replay and include its verification queries.
Concurrent experiments use a separate database, but share PostgreSQL resources.
The pending three migrations are tested there; the replay keeps its starting schema.

The source inventory identifies 249 functions with 683 write sites.
Of these functions, 172 lack a lexical `IS DISTINCT FROM` match.
It also identifies 219 without a local lock-timeout clause and 221 without a local statement-timeout clause.
Role defaults still apply. These counts identify review work; they do not establish defects.

| Role | Statement timeout | Lock timeout | Idle transaction timeout |
| --- | --- | --- | --- |
| `anon` | 3 seconds | 500 milliseconds | 60 seconds |
| `authenticated` | 8 seconds | 500 milliseconds | 60 seconds |
| `authenticator` | 8 seconds | 500 milliseconds | 60 seconds |
| `service_role` | 3 seconds | 250 milliseconds | 60 seconds |

The catalog confirms these defaults on the private stack.
The earlier live timeout test proves idle-session cancellation.
Phase-specific budgets and all remaining write paths still require review.

## Daily screen statistics

The supplied production observation reports `view_player` falling from 700 to 94 ms after manual ANALYZE at 17:33 UTC.
This audit makes no production connection and does not reproduce those exact timings.
Migration `20261201000100` adds daily statistics work to the existing off-peak retention task.
Retention queues fifteen table tasks, keyed by UTC date and relation.
The existing dispatcher runs them serially under its advisory lock.
Each task analyzes one allowed table, with a 100-millisecond lock limit and a three-second statement setting.
Its maintenance memory setting is sixteen MiB.
Repeated retention calls do not duplicate that day's tasks.

The targets include players, stats, season averages, season totals, games, rankings, lineups, rosters, matchups, and all six forecast tables.
Each physical target uses an analyze scale factor of 0.02 and a threshold of 25 changed rows.
New stats partitions receive the same settings.
PostgreSQL does not automatically analyze the partitioned parent, so the daily task also analyzes that parent explicitly.

The restored-data churn check performs 8,365 unchanged-value updates across 83 populated physical tables.
Every table receives a new `pg_stat_user_tables.last_autoanalyze` value within 120.421 seconds after the first churn pass.
Small tables receive additional updates to cross the fixed threshold.
The one empty default partition has no automatic-analysis requirement until rows arrive.
All fifteen logical table fingerprints remain equal across the initial churn pass.
The separate maintenance suite passes 26 checks, including daily deduplication, permissions, worker execution, and future partition settings.
All 52 screen hashes match before and after the migration.
The restored benchmark applies and attests 653 migrations; the running replay retains its original schema.

Run these daily checks with the private administrative connection:

```sql
WITH targets AS (
  SELECT unnest(private.screen_statistics_targets()) AS relation
), relations AS (
  SELECT relation FROM targets
  UNION
  SELECT tree.relid FROM targets CROSS JOIN LATERAL pg_partition_tree(relation) tree
)
SELECT stat.relid::regclass AS relation, stat.n_live_tup,
  stat.n_mod_since_analyze, stat.last_analyze, stat.last_autoanalyze
FROM relations JOIN pg_stat_user_tables stat ON stat.relid=relations.relation
ORDER BY stat.relid::regclass::text;

SELECT status, count(*), max(completed_at) AS latest_completion
FROM private.work_items
WHERE kind='analyze-screen-table'
  AND key LIKE (now() AT TIME ZONE 'UTC')::date::text||':%'
GROUP BY status ORDER BY status;
```

## Function memory measurements

A streaming scan examines all 3,500,386 plans in the preserved partial logged capture.
It finds zero temp writes, disk sorts, or multi-batch hashes.
This result covers that capture, not the missing full-workload plans.
The logging-off experiment tests seven expensive screen functions and three forecast or value functions.
Three rounds compare function-local settings of four, eight, and sixteen MiB.
All 495 measured calls preserve their result hashes and report zero temporary blocks.

| Function | 4 MiB median ms | 8 MiB median ms | 16 MiB median ms |
| --- | ---: | ---: | ---: |
| `view_claim_editor` | 96.554 | 97.193 | 91.474 |
| `view_player` | 24.836 | 24.514 | 23.612 |
| `view_players` | 49.762 | 49.611 | 49.627 |
| `view_trade_details` | 35.749 | 37.081 | 37.590 |
| `view_trade_analysis` | 31.096 | 31.271 | 31.940 |
| `view_trades` | 30.526 | 29.244 | 33.400 |
| `view_player_search` | 39.229 | 39.458 | 39.988 |
| `prepare_matchup_forecast_inputs` | 4.984 | 4.609 | 4.636 |
| `compute_matchup_forecast_context` | 127.478 | 125.792 | 128.077 |
| `get_dynasty_pick_values` | 27.140 | 26.712 | 26.543 |

No larger setting removes a spill, so no `work_mem` override is retained.
Some timings improve and others regress. Those changes do not justify additional memory.
The tests share the container with replay and automatic maintenance; they do not establish isolated throughput.

## Player reads: 2026-10-28 baseline

The private mini uses project `pt4bafablepp` and database port `59122`.
The schema comes from release 2.6.2 at `045f2d09`.
The data comes from the 2026-10-28 production backup.
The restore excludes a removed dispatch table and incompatible storage metadata.
The tested tables contain 2,618 players, 245,097 game lines, and 3,817 season totals.
The selected real member has 25 roster players.
The home response includes a matchup and ten starting slots.
The projection response includes 461 players.
The dynasty response includes 404 players.
Background jobs stay disabled throughout this work.
No production service receives a request.

Each function gets three warmups and 20 measured executions in one transaction.
Each measurement uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` as `authenticated` with the member's user claim.
Percentiles use nearest ranks: sorted samples 10 and 19.
Times below use PostgreSQL execution time in milliseconds.
Every final sample reads zero shared blocks from disk.
The JIT setting stays enabled with default thresholds.
However, `pg_jit_available()` returns false on the mini image.
This test cannot measure production JIT costs.
These quiet mini measurements do not reproduce the reported production latency.
Production load and hardware differ; this test cannot assign their separate costs.

| Function | p50 ms | p95 ms | Shared hits |
| --- | ---: | ---: | ---: |
| view_player, overview | 6.216 | 6.858 | 493 |
| view_player, full | 10.805 | 11.060 | 932 |
| get_league_projection_rows | 63.212 | 65.861 | 19,923 |
| get_dynasty_forecast_inputs | 266.269 | 274.467 | 47,815 |
| view_home | 5.478 | 6.382 | 636 |

Nested plans expose a repeated dynasty join over season fantasy averages.
The join scans 411 season totals for each of 404 players.
One traced execution spends 235 ms before it joins projections.
The projection plan also repeats scans of materialized player lists.

Run `node tests/db/player-page-performance.mjs --output <private-output.json>` on this isolated database.
Set `SUPABASE_DB_URL` to its loopback connection and `PANCAKE_TEST_DB_PORT=59122`.
The recipe requires loopback and the configured local database port.
Raw snapshots contain restored data and stay outside the repository.
Run `PLAYER_PAGE_EVIDENCE=<private-output.json> npx vitest run tests/db/player-page-performance.test.ts` to check captured evidence.

### Change 1: compute dynasty fantasy averages once

The dynasty function now materializes fantasy averages for the requested league and season.
It joins those rows to the selected players once.
No index or security rule changes.
The paired run uses one transaction, so both snapshots share the same clock and data.
All 18 complete JSON snapshots match.

| Function | Before p50 | Before p95 | After p50 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| view_player, overview | 6.214 | 7.062 | 6.368 | 7.948 |
| view_player, full | 10.641 | 11.285 | 10.560 | 10.815 |
| get_league_projection_rows | 63.087 | 67.470 | 63.863 | 66.424 |
| get_dynasty_forecast_inputs | 267.881 | 278.992 | 52.565 | 57.235 |
| view_home | 5.517 | 6.496 | 5.550 | 5.809 |

Dynasty p95 falls 79.5%; shared hits fall from 47,815 to 18,396.
Other functions show timing noise; their plans stay unchanged.
The dynasty SQL recipe passes, including authorization checks.
The captured evidence passes 24 tests; nine related tests also pass.
Catalog, types, and migration attestations regenerate successfully.
Catalog and source parity checks pass.

### Rejected projection experiments

Inlining the shared player list increases repeated table reads.
Its projection p95 rises from 68.166 ms to 86.844 ms.
Its dynasty p95 rises from 55.503 ms to 57.268 ms.
Its overview p95 rises from 7.730 ms to 7.979 ms.
Its full player p95 rises from 11.282 ms to 12.826 ms.
Its home p95 moves from 6.445 ms to 5.854 ms without a plan change.
The experiment is reverted.

Materializing the Sleeper schedule cuts projection shared hits from 19,923 to 9,048.
Its projection p95 still rises from 64.639 ms to 66.232 ms.
Its dynasty p95 stays near 52.74 ms.
Its overview p95 rises from 6.888 ms to 7.957 ms.
Its full player p95 moves from 12.923 ms to 11.040 ms.
Its home p95 moves from 6.199 ms to 5.960 ms without a plan change.
This experiment is also reverted because latency does not improve.
No index is added.
The retained change only rewrites the dynasty function.

### Final paired measurements

The final comparison reinstates the original dynasty source inside a transaction.
It then applies migration `20261130000100` and repeats all measurements before rollback.
All 18 full JSON snapshots match.
They cover player sections, historical seasons, projection modes, pagination, search, authorization, and populated home lineups.
Every function gets 20 measured warm executions before and after.

| Function | Before p50 | Before p95 | After p50 | After p95 | Target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| view_player, overview | 6.226 | 7.057 | 6.144 | 6.275 | 300 |
| view_player, full | 10.602 | 11.052 | 10.678 | 10.960 | 300 |
| get_league_projection_rows | 63.026 | 65.442 | 63.836 | 68.825 | 500 |
| get_dynasty_forecast_inputs | 267.038 | 277.629 | 52.205 | 53.603 | — |
| view_home | 5.594 | 6.490 | 5.707 | 7.324 | 300 |

Dynasty p95 falls 80.7% in the final paired run.
Shared hits fall from 47,855 to 18,436.
The other functions keep their original plans and shared-hit counts.
Their small timing changes are noise.
All required mini targets pass before and after the change.
The reported production latency remains unreproduced.

Use `--baseline <original-function.sql> --migration supabase/migrations/20261130000100_player_page_speed.sql` for the paired recipe.
For release 2.6.3, obtain the Hashtag baseline with `git show 30a5b2a0:supabase/sql/functions/by-name/public/get_dynasty_forecast_inputs.sql`.
The recipe rolls back all definitions after the comparison.
The snapshot guard rejects a changed value, added field, or reordered array.
A deliberately changed real overview snapshot fails one test while the other 24 pass.

## Player read release order

Migration `20261130000100` replaces the dynasty reader without changing its inputs, output columns, grants, or JSON values.
Apply this migration through the normal database release process.
Database, then Edge, then merge the frontend.
This task only commits local changes.
It does not run a release.

## Verification

| Check | Result |
| --- | --- |
| `PLAYER_PAGE_EVIDENCE=<final.json> npx vitest run --maxWorkers=2` | 4,195 pass; zero fail; 39 existing gated tests skip. |
| Captured performance and snapshot tests | 25 pass, including 18 complete JSON comparisons and all latency targets. |
| Deliberately changed real snapshot | One expected failure; the other 24 tests pass. |
| `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/dynasty-decision-inputs.sql` | Pass, including custom scoring, pagination, and authorization. |
| `npm run check:quality` | Pass, including lint and every configured type check. |
| `npm run generate:db-function-catalog` | Pass; generated catalog stays unchanged. |
| `npm run generate:database-types` | Pass; generated types stay unchanged. |
| `node scripts/regenerate-release-history-attestations.mjs` | Pass; both attestations include all 627 migrations. |
| `npm run check:db-function-catalog` | Pass against the private database. |
| `npm run check:database-types` | Pass against the private database. |
| `npm run check:db-function-sources` | Pass. |
| `node scripts/regenerate-release-history-attestations.mjs --check` | Pass. |
| `git diff --check` | Pass. |

The release-order test now reads these health notes and accepts the existing supplied-head wording.
Its negative checks still reject missing sections, migration numbers, and production-head declarations.
An earlier full run rejects an experimental migration with stale attestations.
The final full run uses the retained migration and passes.

The private stack stops after verification, and its database volume is removed.
Copied backup files and raw response snapshots are deleted.
Private timing results, plans, and matching snapshot hashes remain available.
Production, CI, deployment, email, and push services receive no request.

## Release 2.6.3 integration on the restored backup

The integration includes main commit `8cbaee99` and preserves the active replay's original code.
The incoming scheduler restores Hashtag work but replaces the daily missing-final-stats enqueue.
The updated reconciliation test fails on that incoming definition.
Migration `20261201000200` preserves both schedules.
Its before/after plans retain every other queued work count and add exactly one missing-final-stats task.
Both sides queue all three Hashtag views.
The 44-condition schedule suite and nine-condition trade-reader suite pass.
The trade-reader fixture now creates its own player and pick values instead of requiring a prior import.

The player-read benchmark uses the restored data after statistics verification.
It compares the Hashtag reader before and after the incoming player-speed migration in one transaction.
Each side has three warmups and twenty measured calls for five functions.
All eighteen complete JSON snapshot pairs match.
Dynasty-reader p95 falls from 334.721 to 78.045 ms; its final shared-hit sample falls from 50,795 to 19,764.
The other four functions keep their definitions in this comparison and show ordinary timing variation.
This probe does not replace the complete two-day or concurrency requirements.
The integrated benchmark applies and attests 656 migrations through `20261201000200`.

## Reusing current forecast projection inputs

Migration `20261201000300` reuses a prepared date when its source revision, scoring rules, roster, observation day, and expiry still match.
Concurrent recomputation also avoids updating an identical cached row.
The first candidate only compared rows after recomputation; its median rose from 303.965 to 333.107 ms, so it was rejected.
The retained change checks cache validity before the expensive projection query.

Five paired twenty-call probes keep logging off and preserve identical cached rows.
Warm-call median time falls from 285.600 to 4.772 ms.
Buffers fall from 97,384 to 688, WAL falls from 61,068 bytes to zero, and cache updates fall from twenty to zero.
With a changed source revision before every call, both versions still perform twenty required updates.
That cold probe measures 303.485 ms before and 304.514 ms after, with 94,217 and 94,266 buffers respectively.
These cold timings do not establish an improvement.

The regression test fails before the change and passes nine conditions afterward.
It checks new projections, changed scoring, roster changes, expiry, observation-day changes, and excluded dates.
The existing parity test passes on a fifty-player matchup, including corrections and source changes.
Cache, history, worker, and statistics-maintenance suites also pass.

## Recent score-dispatch index

The plan review finds a cooldown check that scans completed invocations for recent `sync-scores` work.
Migration `20261201000400` adds a partial time index for that worker.
Five paired empty checks fall from 194 to three buffers and from 0.508 to 0.037 ms.
Populated checks fall from 168 to three buffers and from 0.447 to 0.024 ms.
All boolean results match, including the exact thirty-minute boundary.

The index adds write work for matching invocations.
One hundred score inserts measure 21.263 ms before and 21.740 ms after; WAL rises from 42,297 to 47,328 bytes.
One hundred ordinary inserts measure 21.846 and 21.737 ms; buffers rise from 8,186 to 9,032.
A controlled mix of 150 cooldown checks and ten inserts measures 60.745 ms before and 4.899 ms after.
Its buffers fall from 40,822 to 2,509; WAL rises from 3,129 to 3,760 bytes.
That mix is a workload probe, not an inferred production rate.
The measured combined gain supports retaining the index despite its write cost.

The plan-budget test fails without the index and passes four conditions with it.
All 52 screen hashes match; schedule, reconciliation, and invocation-retention suites pass.
The existing reconciled-time index records 417 scans in the running replay and remains installed.

## Shared player-average refresh input

Migration `20261201000500` computes each season's average input once for cache updates and stale-row deletion.
The earlier function reads the same source again during deletion.
Five paired fifty-call probes reduce median time from 930.131 to 514.767 ms and buffers from 113,499 to 109,037.
Both sides write 22,248 WAL bytes and retain identical complete cached rows.
This change reduces repeated calculation; it does not claim incremental team/week or standings maintenance.

Seven focused conditions cover source insertion, stale-row deletion, unchanged timestamps, corrections, old versions, and an empty source.
The existing cache, screen-parity, and player-search suites pass.
The cache fixture now models completed work, the single-item claim limit, and the retry delay.
It checks the current false return for incomplete trade valuations and verifies that the work remains retryable.
The repaired fixture passes with both the old and new average functions.

The merged ranking parser also preserves all 852 stored ranking rows across the three reconstructed provider views.
No simulator source change is required for that compatibility check.

## Database-scoped plan coverage

The log reader now matches plan records to the database named in both counter snapshots.
It ignores another database's records and rejects snapshots from different databases.
Plans without database identity cannot prove scoped coverage.
The compactor also keeps separate representatives when two databases use the same query identifier and plan shape.
A three-failure negative control exposes the previous behavior; all twenty parser, compactor, and coverage tests now pass.
This distinction matters because the isolated benchmark shares the replay's PostgreSQL log collector.

## Completed replay and counter limitation

The new replay completes both days, thirteen games, 450 stat rows, and 4,154 live checks on source `4ced613b`.
The checkpoint verifies trigger fidelity and records no replay failure.
The outer reporter then fails because several statement metrics decrease between snapshots.
The statistics collector reports 86 deallocations with the same global reset time and a 5,000-entry limit.
Concurrent benchmark activity shares that collector.
Statement totals and throughput from this interval are unavailable.

The failed reporter leaves older result files behind.
The recovery uses the current checkpoint, current source archive hash, and matching before/after snapshots instead of those files.
It preserves the original failed exit status and marks statement metrics incomplete.
The harness now removes old result files before a new run.
It retains validated storage growth when statement counters become unusable, while still rejecting a changed database, server, or reset time.
Fifteen focused window and health tests pass.
Simulation timing, game inputs, worker actions, and verification rules remain unchanged.

The October 28 18:23:21 UTC snapshot has 241,937,555 database bytes, 205 table entries, 925 index entries, and 1,147 statement entries.
It records zero lock waits, idle transactions, or Final games without stats.
The outbox has 671 estimated live rows, zero estimated dead rows, and 835,584 allocated bytes.
Its 511 updates include 22 HOT updates.
Player season totals record 27,457 updates and 24,152 HOT updates.
These numbers describe the completed 649-migration replay; the isolated development database has 659 migrations.

The private primary database now applies all 659 migrations. Its catalog and loopback generated-type checks pass after the replay.

## Capture interval checks

Plan coverage now rejects plans recorded outside the snapshot interval.
It also rejects credit from records without a timestamp when the snapshots define an interval.
A regression test fails against the earlier reader, which accepted an unrelated later execution.
All 23 parser, compactor, and coverage tests pass.

The summary reader now streams compressed logs and filters the source database.
It preserves separate anonymous function contexts and reports their count.
It keeps the slowest and most buffer-heavy example for each query.
It also reports disk spills and index use across every parsed plan.
These summaries do not mark missing or unidentified statements as reviewed.

```sh
node scripts/db-health/plan-summary.mjs --stream backend-plans.jsonl.gz postgres > plan-summary.json
```

## Preserved full-log review

The streaming summary reads 3,498,732 plans from the preserved primary-database log.
It finds 1,653 query texts, 353 index names, and zero disk spills.
The 9,231 anonymous plans belong to three information-schema expression helpers.
The summary completes in 52.91 seconds with 601.58 MiB peak resident memory.
These timings measure the Mac parser, not database query speed.

The review identifies 26 statements above 5,000 buffers and seven heavily filtered scan samples.
Their retained plans identify these remaining measurement areas.

| Area | Finding | Decision |
| --- | --- | --- |
| Forecast preparation | Repeated projection and expiry calculation | Compare the current cache-gated function; the old wrapper is superseded. |
| Dynasty and pick readers | Stored-average and roster aggregation | Continue the aggregate and pagination review. |
| Notification candidates | Nested global candidate scanning | Recheck the current bounded claim implementation. |
| Player imports | Identity locking and import wrappers | Recheck the merged identity and import fixes. |
| Game statistics | Season reads touch other-season partitions | Keep the partition-read regression open. |
| Score cooldown | A 5,902-row filtered scan | The measured recent-score partial index already addresses this case. |
| Total cleanup | 3,831 rows scanned in 0.291 ms | Do not add a HOT-sensitive index without a measured net gain. |
| Schema and clock inventory | Catalog scans during startup or diagnostics | No application index change. |

The matching snapshot interval contains 1,254 executed statement entries.
Coverage finds 397 captured entries, 36 utilities, and 821 missing plans.
It rejects 3,388,604 records outside that interval and 36 plans without database identity.
This result is incomplete and does not close the earlier two-day coverage gap.
Use the raw log for interval coverage; compaction can retain a representative outside the requested interval.

The outer log query ID differs from the nested plan ID in 19,797 of the first 20,000 plans.
The reader therefore uses the nested ID and never substitutes the session query ID.
A new regression test enforces this rule. All 24 parser, compactor, and coverage tests pass.

## Write-review inventory correction

The source inventory now excludes row-lock clauses, comments, and string literals, including nested dollar-quoted SQL from direct write counts.
It reports conflict-update branches and dynamic SQL separately.
Two negative controls fail against the previous scanner. Ten focused health and source tests pass.

| Current source measure | Count |
| --- | ---: |
| Functions | 521 |
| Functions with direct writes | 239 |
| Direct INSERT, UPDATE, and DELETE statements | 580 |
| Conflict-update branches | 69 |
| Row-lock clauses | 304 |
| Functions with dynamic SQL | 22 |
| SELECT-star sites outside literals and comments | 275 |
| Write functions without a distinctness expression | 169 |
| Write functions without a local lock timeout | 209 |
| Write functions without a local statement timeout | 211 |

These are review candidates, not defect counts.
The four application roles retain their bounded statement, lock, and idle-transaction settings.
The work dispatcher also sets a five-second statement limit and a 250-millisecond lock limit in its cron command.
The direct half-minute hint-drain command has no matching outer timeout settings.
Its two hint functions also lack local limits; this phase still needs a contention test and correction.

## Statistics during the current replay

At October 28, 19:08:40 UTC, all 15 daily ANALYZE tasks have succeeded on the 659-migration stack.
All 84 physical screen tables retain the 0.02 analyze scale factor and 25-row threshold.
Eleven tables receive a new `last_autoanalyze` after the workload starts.
They include player averages, season totals, games, matchups, five forecast tables, and two current-season stats partitions.
The automatic timestamps come from real game churn during this replay.
The earlier controlled churn test covers all 83 populated physical tables.
The empty default partition has no rows to churn.

This is an intermediate observation; both replay days still require verification.
Statement logging remains off, and the private statement counter limit is 50,000 for this capture.
That diagnostic limit prevents the earlier eviction problem. It is not a production configuration change.

## Hint-drain verification

Migration `20261201000600` bounds the direct half-minute drain with a three-second statement timeout and a 250-millisecond lock timeout.
It retains both operator-pause checks.
The blocked-row probe changes from the test fallback at 1,522.3 ms to a lock timeout at 271.7 ms.
A forced slow statement stops at 3,021.2 ms.
Seven checks confirm cancellation, rollback, pause handling, and exactly-once retry results.
Unblocked before-and-after plans produce the same two revisions and empty queues.

The balance-contention test still finds a lock on `private.screen_refresh_queue`.
It is a separate unresolved write-path issue.

## Latest replay interruption

The October 29 replay day passes final-game and scoring checks for three games.
The October 30 replay stops at 23:37 when the private Docker disk fills.
PostgreSQL profiling logs occupy about 37.8 GiB at failure.
The clock is restored, and closed logs are archived with decompression and SHA-256 verification before removal.
This run does not provide a complete two-day baseline.

The completed archive contains 965 closed logs totaling 40,593,342,225 bytes.
Verified compressed copies total 1,833,470,154 bytes.
The replacement capture archives closed logs during execution to bound local diagnostic storage.

## Balance publication contention

The original 25-check contention test passes without changes.
Inventory hints defer screen invalidation when the transaction already queues a version publication.
Balance-only version conflicts retain pending work for the next hint drain.
Other serialization conflicts still abort the transaction.
Reads report stale data until the pending publication finishes.

| Fifty balance updates | Before | After |
| --- | ---: | ---: |
| Median execution, five pairs | 24.525 ms | 20.805 ms |
| Median shared buffers | 4,867 | 4,752 |
| Median WAL bytes | 42,879 | 39,456 |

The probes return identical balances, version changes, hint revisions, and queue counts.
Twelve additional checks cover deferred publication and access limits.
All 52 backup screen hashes match, and 63 screen-field checks pass.
These measurements use the restored audit database with statement logging off.

## Bounded plan capture

The next capture samples one in ten executions and rotates PostgreSQL logs at 10 MB or one minute.
It checks VM disk space before startup and stops logging below 20 GiB free.
Logging starts at the measured workload and stops before cleanup.
Each raw segment is deleted after its summary and retained plans pass validation.
Retained plans and summary files each have a 64 MiB limit.

A real archived segment contains 48,202 plans in 141,517,713 uncompressed bytes.
Its verified retained plans occupy 196,630 bytes.
Sampling can miss rare statements; the coverage report must identify and resolve those gaps before acceptance.

## Client publication

Migration `20261201000900` publishes the exact union of current client subscriptions.
It retains 16 tables from the supplied 22-table publication.
The [release contract](../supabase/RELEASE-DB.md#realtime-publication) lists every retained and removed table.
The app-wide hint stream, forecasts, claims, league updates, player support, trades, and drafts stay published.
`draft_room_members` has no active subscriber and is removed with the other five unwatched tables.
The unused league watch factory does not count as a subscription.

The earlier six-table publication is incorrect and superseded.
Its one-row logical-decoding result does not establish a valid release gain.
The corrected probe requires draft updates, league updates, and league invalidation hints in logical replication.
The static check rejects missing and unwatched tables before a database runs.

The simulator verifies a real draft update and restores its timer before measuring the workload.
It waits for the database-feed readiness event after the channel joins.
A live probe misses the update before this wait and receives it afterward.
Five focused checks preserve the missing-event failure and cover the readiness race.

## Worker concurrency bound

Migration `20261201001000` permits four active work items and at most four starts in each dispatcher pass.
The production schedule invokes that dispatcher each minute.
A queue fixture confirms that all eight items finish across two batches.

Three paired probes execute the same eight authenticated player-screen reads with eight open database connections.
Each read retains its result for 1.5 seconds.
Median peak anonymous resident memory falls from 275.4 MiB with eight concurrent reads to 240.2 MiB with four.
The baseline for eight idle connections is 25.94 MiB in both variants.
Every result hash remains identical.
These are PostgreSQL process measurements, not Edge-runtime or whole-instance memory measurements.
The full replay must verify scheduling and whole-instance peaks after this cap.

Run these daily checks alongside the table and retention queries above:

```sql
SELECT count(*) FILTER (WHERE status='running' AND lease_until>clock_timestamp()) AS active_workers,
  count(*) FILTER (WHERE status='running' AND lease_until<=clock_timestamp()) AS expired_leases,
  count(*) FILTER (WHERE status IN ('pending','failed') AND due_at<=clock_timestamp()) AS due_items,
  min(due_at) FILTER (WHERE status IN ('pending','failed')) AS oldest_pending
FROM private.work_items;

SELECT schemaname,tablename
FROM pg_publication_tables
WHERE pubname='supabase_realtime'
ORDER BY schemaname,tablename;
```

The active-worker count must stay at four or fewer.
The publication query must return the 16 client tables in the release contract.
The queue fixture returns four active workers, rejects another claim, and admits the remaining four after completion.

## Player game pagination

Migration `20261201001100` returns a bounded game page and a date-and-ID cursor.
The client keeps requests at 15 rows instead of requesting every preceding page again.
Nine SQL checks cover tied dates, all 37 fixture rows, stable paging after an insertion, cursor validation, and authenticated access.
All 52 screen hashes remain identical outside this page response.

| Six-page walk, five paired probes | Before | After |
| --- | ---: | ---: |
| Rows returned to the caller | 86 | 86 |
| Median execution | 22.044 ms | 6.179 ms |
| Median shared buffers | 3,108 | 1,788 |
| Response bytes | 432,755 | 127,978 |

Every completed page walk has the same ordered result hash.

The broader version-write fixture passes 126 checks after honoring deferred trade publication and isolating roster ownership between case groups.

## Minute-worker incident corrections

The operator reports 97 percent production CPU from 20:50 to 21:25 UTC on October 28.
The reported idle workers take four to eight seconds for screen refresh and two to six seconds for forecasts.
The half-minute hint job records 45 runs in thirty minutes, with a sixteen-second mean and a 252-second maximum.
These production figures are supplied evidence; this audit makes no production connection.

Migration `20261201000200` now includes the requested minute schedules and session advisory guards.
That number belongs to this lane's reconciliation fix, so migration `20261201001200` also applies the definitions to existing installations.
Both jobs use a five-second statement timeout and a 250-millisecond lock timeout.
The lock keys use `hashtext('io-hint-drain')` and `hashtext('work-dispatcher')`.
The commands release their locks on success, cancellation, and other errors.
An actual `cron.alter_job` probe installs both definitions inside a rolled-back transaction on the private stack.
The guarded overlap returns in 25.5 ms without draining either pending hint.
The separate blocked-row check cancels in 264.6 ms, and the statement limit cancels in 5,024.0 ms.

The forecast timeout is reproduced while another connection holds the screen-refresh queue row.
Forecast publication previously tries to invalidate that unrelated queue and raises `55P03`.
Migration `20261201001300` keeps the forecast version notification and skips the unrelated screen rebuild.
The same contended publication completes in 3.0 ms and preserves the screen queue's version and dirty flag.
Seventeen concurrency checks pass, including the existing membership and deferred-balance cases.
The same migration ignores unchanged row updates when deciding whether to refresh screens.

Expired trade publication dates also restart screen work without changed league inputs.
Migration `20261201001400` uses changed versions to request and complete refreshes.
Readers retain their existing expiry and stale-data indicators.
Five paired sixty-tick probes preserve identical player-cache contents.

| Sixty idle checks with expired trade values | Before | After |
| --- | ---: | ---: |
| Refresh worker calls | 60 | 0 |
| Median database time | 1,065.135 ms | 7.400 ms |
| Shared buffers | 140,173 | 3,044 |
| WAL bytes, including fixture retry updates | 74,325 | 8,478 |

The already-clean polling control falls from 1.725 to 0.956 ms across sixty calls.
That control writes no WAL and queues no workers in either version.
These local SQL measurements do not reproduce the supplied production HTTP timings.
