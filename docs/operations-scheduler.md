# Scheduler operations

## Load shedding

The dispatcher refreshes at most eight live matchup totals before checking scheduler health.
It checks health before adding or claiming other work.
The check reads at most forty cron rows through the existing primary key, newest first.
It filters those rows to the last five minutes.
Forty rows cover about ten minutes at the current three-job cadence.
Its success ratio uses completed dispatcher runs.
It measures average and maximum duration in seconds.
Startup timeout counts include every cron job.
Backend counts exclude the health check itself.

| State | Entry rule | Work cadence |
| --- | --- | --- |
| `normal` | Initial state or ten continuous healthy minutes | Existing schedule and four-worker cap |
| `shed` | Success below 80%, average above three seconds, or unavailable health | Essential kinds only; reduced polling and waiver cadence |
| `paused` | Success below 50% or any startup timeout | Live totals every dispatch; other critical kinds every five minutes |

`paused` is the paused-heavy state.
Manual pause remains a separate control and stops all dispatch.
Worsening health changes the state at the next dispatcher call.
Improving health keeps the current restriction for ten continuous healthy minutes.
A failed check, missing sample, or check gap above 90 seconds resets that recovery period.
An empty history does not change the initial normal state.
It cannot recover a restricted state.

The essential kinds in `shed` are:

- `live-poll`
- `sync-scores`
- `stats-sync`
- `process-waivers`
- `process-trades`
- `edge-invocation-reconcile`
- `refresh-live-matchups`

The critical kinds in `paused` are `process-waivers`, `process-trades`, `live-poll`, and `refresh-live-matchups`.
In `shed`, live polling enqueues on even minutes and waivers enqueue every 15 minutes.
Skipped work keeps its due date and attempt count.
Existing worker leases finish under their current limits.
The four-worker cap still counts every active lease.
The restricted scheduler does not run the normal enqueue scan.

The heavy kinds are `refresh-views`, `matchup-forecasts`, `trade-estimate`, `sync-trade-values`, `pick-predictions`,
`pt:fantasypros`, `pt:sleeper-day`, `pt:sleeper-week`, and `sync-rankings`.
Every other nonessential kind also waits during `shed`.
These are `cleanup-trade-estimates`, `close-expired-nominations`, `daily-stat-corrections`,
`league-inventory-hint-drain`, `lineup-optimizer`, `missing-final-stats`, `mock-room-expiry`, `pg-net-response-vacuum`,
`player-injuries`, `player-stats-hints`, `pre-tipoff`, `public-read-retention`, `retention-prune`, `season-boundary`,
`setup-season-rollover`, `sync-draft-order`, `sync-players`, `sync-schedule`, `trade-activation`, and `trade-publication`.
New kinds also wait until explicitly admitted.

Read `public.get_scheduler_health()` through the service role.
It returns the last measurement, state, recovery start, manual pause, and admin hint.
Check `checked_at` before trusting a healthy result.
A stale timestamp means the dispatcher cannot check health.
The monitor must alert on stale health as well as restricted states.
The watchdog cannot run when cron cannot start the dispatcher.
It reduces load before that point; it cannot guarantee recovery from total CPU starvation.

Each transition adds one row to `private.scheduler_health_log`.
It updates the single `public.scheduler_health_hint` row.
Neither write touches league hints or versions.
Both tables restrict reads to the service role.
The RPC performs no writes and does not run a fresh health scan.

The cron command retains its five-second statement limit.
The health scan adds no cron index and uses a 100-millisecond lock limit.
A canceled or failed health scan falls back to `shed`, or keeps the stricter paused state.
If the check consumes the dispatch budget, the call saves the state and admits no work.

Run the transition recipe on the private database:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/scheduler-health.sql
```

The recipe copies cron history and rolls back every change.
It tests thresholds, recovery gaps, allowed kinds, unchanged normal admission, bounded reads, and a real statement timeout.
The existing work queue recipes test the unchanged normal scheduler.

The private fixture contains 100,005 cron rows.
The bounded plan reads forty rows in 0.092 milliseconds in the measured run.
Removing the limit reads 100,005 rows and fails the bound check.
Separate failing controls admit heavy work and recover one minute early.
Both fail their intended checks.
A locked cron table produces `shed` within 114 milliseconds.
The service RPC also passes inside a read-only transaction.


## Daily statistics

The `screen-statistics` cron job runs daily at 10:15 UTC.
Its command sets `statement_timeout` to ten minutes and `lock_timeout` to two seconds.
It calls `private.refresh_screen_statistics()` in its own database connection.
Each ANALYZE statement names one of the 15 permitted target relations.
PostgreSQL also samples the children of a partitioned target.
A lock timeout skips that target and continues with the next one.
An overall timeout cancels this job without cancelling dispatch.
The function returns each target, elapsed milliseconds, and its result.
An advisory lock prevents overlapping manual calls.

Migration 041 checks statistics before sampling each target.
It uses the table's analyze threshold plus its scale factor times estimated rows.
Missing table options fall back to PostgreSQL's global settings.
It includes partition children and changes pending in the current transaction.
Never-analyzed relations and invalid row estimates still require sampling.
Fresh targets return `status: fresh` and perform no ANALYZE.
The independent daily cron keeps its existing schedule and statement budget.

Run `tests/db/statistics-freshness.sql` for threshold, partition, empty-table, and retired-work checks.

The old `analyze-screen-table` work kind is retired.
The migration marks its pending, failed, and running rows dead and clears their leases.
Enqueue and claim reject retired work; direct execution also retires a stale lease.
Retention and partition creation perform no ANALYZE.
Trade publication performs no ANALYZE through triggers.
The existing leaf-table autovacuum settings remain active.

Read `pg_stat_all_tables.last_analyze` and `cron.job_run_details` when checking the daily job.
Check a skipped target's lock holder before manually retrying the job command.
The catalog check rejects ANALYZE, VACUUM, or REINDEX outside the independent statistics function.
It also rejects SQL functions that call that function.

Run the concurrency recipe only with restored production-shaped statistics:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/statistics-dispatch-isolation.psql
```

[Statistics isolation evidence](release-2.7.1-statistics-isolation.md) records the timings and controls.

Queued trade revaluations, checks, and scans follow other work kinds.
Only one expensive revaluation runs per league.
A private league row permits one new revaluation each minute and survives queue coalescing.
The four-worker cap and expired-lease recovery remain in place.
Foreground trade estimates are claimed before queued background revaluations and bypass their league pace.
Worker completion events still publish league versions and realtime hints.
Events alone do not rebuild standings, matchup totals, or player averages.
# Live scores during scheduler shedding

`refresh-live-matchups` remains essential during automatic shedding and pause.
It runs before the heavy worker admission limit and consumes at most eight pending matchups.
It counts toward the four-item dispatch batch while existing Edge leases can continue.
Score publications coalesce in a separate pending queue.
The refresh copies authoritative points for current matchups with NBA games started today.
Heavy standings, averages, and trade refreshes may wait.
The operator's worker pause still stops dispatch.

Forecast invalidations enqueue scoped requests. A worker fingerprints one matchup per SQL call.
Indexed deadlines wake future preview windows and expire old inputs.
Pending requests make cached forecasts stale and prevent an older computation from publishing.
Notification input changes insert a coalesced dirty marker.
The worker opens a scan in a short transaction, then visits one member per SQL call.
Score publishers do not lock the scan cursor while a member is scanned.
First-scoring-day lookups stay shared within each scan.
Chunk workers yield after 64 calls and retain their cursors for continuation.
They pause for 100 real milliseconds before each call so consecutive chunks do not exhaust a shared CPU quota period.
They leave one worker slot for urgent requests and wait during scheduler shedding.
