# Scheduler operations

## Approved schedule

Cadences below apply during normal operation.
Automatic load shedding can defer nonessential work; manual pause stops new dispatch.

| Work | Cadence |
| --- | --- |
| Live source tick | Every 30 seconds while games are live; none on idle slates |
| Public-mode database import | Status transitions, finals, corrections, and 30-minute recovery checkpoints |
| Saved screen computation | At most every two minutes during games; relevant user actions remain immediate |
| Phone saved-view recovery | Ten minutes with a fresh public snapshot; 20 seconds in stale or database mode |
| Matchup win odds | Every 30 minutes during games, once at matchup end, off otherwise |
| Standings | Weekly matchup end; required initial fill and setup changes remain |
| Season totals and averages | Game end and final-stat corrections |
| Trade analysis | At creation and nightly re-analysis |
| Injury status | Every 15 minutes from two hours before first tipoff through last tipoff |
| Earlier game-day injury status | Hourly |
| Off-day injury status | Daily |
| Projections | Morning and one hour before first game |
| Rankings, trade values, pick predictions, player details | Nightly, in the 04:00–06:00 Eastern window; defer while games remain live |
| Work dispatcher and hint drain | One shared database connection each minute |
| Cron and operational history cleanup | Hourly at :12, bounded batches |
| Screen table statistics | Daily at 10:15 UTC, fresh tables skipped |

Roster moves, lineups and locks, trades, waivers, drafts, login, and their notifications retain their existing event rules.
Direct trade estimates remain immediate; scheduled re-analysis does not block creating an offer.
The [live-score guide](live-scores.md) owns public cache behavior, rollback, and measured usage.

## Admission and leases

`public.dispatch_work()` checks manual pause and an advisory lock before starting work.
It drains player and inventory hints and refreshes pending live matchup totals before normal admission.
It starts no new item after two seconds and admits at most 32 items per call.
At most four unexpired work leases can be active.
Live ingestion gets the first available worker slot before queued background work.
SQL screen and forecast-input chunks reuse the dispatcher connection.
The cron command retains a five-second statement limit and bounded lock waits.

Work leases last five minutes.
The separate live-ingestion lease lasts 90 seconds and renews every 60 seconds.
Live work heartbeats every 120 seconds; other Edge workers heartbeat every 30 seconds and at explicit phases.
Lease loss stops writes.
Temporary gateway failures get at most two live-renewal retries, after 100 ms and 200 ms.
Each request has at most five seconds and must finish one second before the known lease expiry.
Denial, authorization errors, SQL errors, and persistent failures still stop the worker.

Failed work retries with backoff from one minute to a fifteen-minute cap.
The third failed attempt becomes dead work.
Value-source failures retain their separate four-retry policy at 30-minute intervals.
Startup, completion, and reconciliation evidence stay recorded.
Use `work_dashboard()` to inspect due, running, failed, and dead work.
See [incident controls](../supabase/RELEASE-DB.md#worker-incident-controls) before pausing or resuming.

## Load shedding

Health reads at most forty recent cron rows through the existing primary key.
It uses completed dispatcher runs from the last five minutes.
Backend counts exclude the health check itself.

| State | Entry rule | Admission |
| --- | --- | --- |
| `normal` | Initial state or ten continuous healthy minutes | Approved schedule and four-worker cap |
| `shed` | Success below 80%, average above three seconds, or unavailable health | Essential kinds; reduced polling and waiver cadence |
| `paused` | Success below 50% or any startup timeout | Live totals each dispatch; other critical work every five minutes |

Automatic `paused` differs from the operator pause, which stops all dispatch.
Worsening health takes effect on the next dispatch.
Recovery requires ten continuous healthy minutes.
A failed check, missing sample, or gap above 90 seconds resets recovery.
An empty history keeps the initial normal state but cannot recover a restricted state.

Essential kinds are live polling, score and stat sync, waivers, trades, invocation reconciliation, and live matchup refresh.
In `shed`, new live polling queues on even minutes and waivers on 15-minute boundaries.
In `paused`, only waivers, trades, live polling, and live matchup refresh remain eligible.
Skipped work keeps its due date and attempt count.
Existing leases finish under their limits.
All other work waits; new kinds require explicit admission.

`get_scheduler_health()` returns the last measurement, recovery start, manual pause, and admin hint.
Check `checked_at`; a stale timestamp means health cannot be trusted.
Transition history and the current hint are service-role-only and do not bump league versions.
The watchdog cannot recover cron when the dispatcher cannot start at all.

## Daily statistics

`screen-statistics` calls `private.refresh_screen_statistics()` in its own connection at 10:15 UTC.
The command permits ten minutes and a two-second lock wait.
Only permitted target relations can be analyzed.
Freshness uses each table's analyze threshold and scale factor, falling back to PostgreSQL defaults.
Never-analyzed tables and invalid row estimates require sampling.
A lock timeout skips that target; an advisory lock prevents overlapping runs.
The retired `analyze-screen-table` work kind cannot be enqueued or executed.
Retention, partition creation, and trade publication do not run ANALYZE.

## Retention and checks

Hourly cleanup deletes at most 512 cron rows, 4,096 sync rows, 4,096 private broadcasts, and 512 scheduler transitions.
It preserves active executions and required failure or latest-outcome records.
Age limits and storage risks are in [database capacity](db-capacity.md#growth-and-retention).
Cleanup adds no Edge invocation or continuation worker.

Run database checks only against an isolated local stack:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/functions/refresh-views/schedule.test.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/nightly-worker-hours.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/scheduler-health.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/statistics-freshness.sql
```

The replay separately checks timed work, freshness, final state, actions, forecasts, injuries, and broadcasts.
The [lab guide](../scripts/bench/game-night/README.md) describes positive runs and deliberately failing controls.
