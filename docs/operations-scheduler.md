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
| Trade analysis | At creation, nightly, and at most one catch-up pass after matching pick predictions complete |
| Injury status | Every 15 minutes from two hours before first tipoff through last tipoff |
| Earlier game-day injury status | Hourly |
| Off-day injury status | Daily |
| Projections | Morning and one hour before first game, including both halves of All-Star week |
| Rankings, trade values, pick predictions, player details | Nightly, in the 04:00–06:00 Eastern window |
| Work dispatcher and hint drain | One shared database connection each minute |
| Cron and operational history cleanup | Hourly at :12, bounded batches |
| Screen table statistics | Daily at 10:15 UTC, fresh tables skipped |

Roster moves, lineups and locks, trades, waivers, drafts, login, and their notifications retain their existing event rules.
Direct trade estimates remain immediate; scheduled re-analysis does not block creating an offer.
Live games do not gate nightly admission or execution.
Nightly work keeps its existing retry and lease rules without special deferrals.
Public workers discover status changes outside selected imports.
Start receipts use bounded per-game deadlines and leave time for official imports.
Receipt failures remain separate from successful import checkpoints.
Long-delayed Scheduled games retain their retry backoff.
A failed game leaves its checkpoint due while healthy imports continue.
Due official work can use validated direct ingestion when the shared snapshot fails.
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
Age limits and storage risks are in [database capacity](operations-scheduler.md#capacity).
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

## Retention

The dispatcher enqueues one `retention-prune` work item each day after 10:00 UTC.
Daily keys catch up a late tick and prevent duplicate runs.
The work item calls `private.run_retention()` and preserves receipt and beacon cleanup.
The runner stops starting helpers after two seconds and skips locked rows.
Each deletion statement has its own bounded batch.
An advisory lock prevents overlapping retention runs.
A failed table records a short error; other tables can proceed.

`public.retention_dashboard()` requires backend access.
It lists every table, partition, and stored view in the application, Auth, Storage, cron, and network schemas.
Each row shows table bytes, total bytes, estimated rows, its rule, and its last check and prune.
A new table without a saved rule appears as an unassigned retention decision.
Each table has one cumulative prune summary; the job creates no growing run-history table.

| Records | Retention and preserved summary | Maximum deletion per call |
| --- | --- | --- |
| `sync_runs` | Finished success: seven days; failure: thirty days. Keep newest success and failure per function. | 5,000 |
| `edge_invocations` | Reconciled success: seven days; failure: thirty days. Keep newest terminal outcome per function. | 5,000 |
| `cron.job_run_details` | 24 hours for finished or abandoned runs. Active executions stay. Hourly pruning also applies. | 5,000 |
| `net._http_response` | Six hours. Unreconciled invocation responses stay. | 5,000 |
| `notification_outbox` | Sixty days after delivery, suppression, or dead letter. Pending work stays. | 5,000 |
| `sleeper_projection_rows` | Current Pacific week and future dates. | 5,000 |
| `projection_sync_runs` | Current Pacific scoring period and future periods. Delete expired children before runs. | 200 runs |
| `fantasypros_projection_rows` | Same period as the parent run. Current rows stay. | 5,000 |
| `sync_jobs` | Completed jobs: thirty days. Failed and pending resume checkpoints stay. | 5,000 |
| `lineup_tipoff_members` | Thirty days after a terminal dispatch. | 5,000 |
| `lineup_tipoff_dispatches` | Thirty days after finish. Delete only after member receipts expire. | 5,000 |
| `matchup_forecasts` | Seven days after validity and matchup end. | 5,000 |
| `private.matchup_forecast_queue` | Seven days after matchup end, or when voided. Active claims stay. | 5,000 |
| `trade_estimate_quotes` | Unlinked quotes: seven days after expiry. Frozen trade evidence stays. | 5,000 |
| `league_change_hints` | One live revision per league and topic. Delete orphan rows. | 5,000 |
| `auth.refresh_tokens` | Expired or ninety-day inactive sessions. Revoked tokens: seven days. | 5,000 |
| `auth.sessions` | Expired sessions: seven days. Inactive sessions: ninety days. Delete children first. | 500 |
| `private.request_receipts` | Seven days after creation. Preserve the existing replay-result expiry contract. | 5,000 |
| `public.perf_beacons` | Thirty days after receipt. | 5,000 |
| `private.work_items` | Successful items: seven days. Pending, running, failed, and dead items stay. | 5,000 |
| `private.trade_offer_requests` | Keep idempotency receipts with trade history. Operational cleanup never deletes them. | No expiry |
| Retention rules and summaries | One row per table. Keep cumulative deleted counts and the latest error. | Fixed by schema size |
| Provider history policy | One coverage rule per provider. | Fixed by provider count |
| Search caches, live leases, and source state | Replace rows by their existing entity keys. | Fixed by entity count |
| League history, NBA games, statistics, and news | Retain source records and product history with their owning entities. | No expiry |
| Auth and Storage support tables | Their services own lifecycle cleanup, except the session and token rules above. | Service owned |
| Browser screen cache | At most 48 entries and 4 MiB of JSON, with version-based invalidation. | Client owned |
| Other browser caches | At most 64 ordinary entries, with smaller per-prefix limits. Ordinary entries expire after one day; membership entries after thirty days. | Client owned |
| Browser auth, preferences, and editor drafts | Replace fixed keys. Session drafts clear on close, send, sign-out, or account change. | Client owned |
| Avatar files | Upsert one file per supported format per user. Each file is at most 5 MB. | Three current format paths per user |
| Vercel and Edge logs | External provider retention. The application stores no second log copy. | External |
| Replay receipts | Verified summaries remain in replay artifacts after raw database logs expire. | Replay artifact lifecycle |

Abandoned sync and invocation logs become terminal after thirty days.
Each run closes at most 5,000 abandoned rows per table.
The ordinary failure window then applies.
Projection deletion suppresses resource hints and restores the prior cleanup setting.
Run deletion waits for child deletion, so cascades cannot bypass the row budget.
Deletes free reusable space; they do not immediately shrink relation files.

The inherited projection growth estimate is about 5 MB per day.
Daily pruning removes the weekly scheduling delay, but this run does not measure hosted disk savings.
Use dashboard sizes and backlog errors before changing batch limits.
Auth and Storage metadata sizes exclude the stored file bytes.
Storage files require deletion through the Storage API; SQL metadata deletion can orphan blobs.
Deleted-user avatar files still need a Storage lifecycle worker.

The combined schema includes work items, request receipts, league events, and performance beacons.
Queue leases, retries, outcome events, and view refresh remain in the single dispatcher.
Remaining event-history retention rules still need a lifetime or summary decision.
Durable product history, failed resume checkpoints, and saved replay files still need a separate lifetime or summary decision.
These exceptions prevent a claim that every stored byte has bounded lifetime.

## Capacity

## Measured boundary

The current evidence is a synthetic local game-night replay, not a production capacity test.
The fixture has ten teams, about 2,600 players, and 246,000 `player_game_stats` rows.
It remains production-sized; no historical data is removed to improve the result.
The final-code sample measures 265,637,011 database bytes after the timed window.
The budget's database peak is 265,637,011 bytes, or 53.13% of 500 MB.
This is one final-code sample; earlier three-run and held-out sizes remain historical.
Database size is an accepted exception to the half-allowance target.
The final transfer projection reaches 44.59% of 5 GB, within the accepted 55% exception.
Official statistics and results have no automatic expiry.
An explicit historical-data policy or a larger plan is needed before continued growth reaches the allowance.
The replay cannot establish how many months of production growth remain.

## Growth and retention

Allocation changes by 958,464 bytes in the final four-minute sample.
Settlement changes allocation by 180,224 bytes.
These values include reusable pages and maintenance allocation; do not extrapolate them as permanent row growth.
No current production growth rate is measured.

| Data | Retention | Bound |
| --- | --- | --- |
| Successful cron history | 6 hours | 512 eligible rows per hourly cleanup |
| Failed cron and orphan checks | 24 hours | Same cleanup |
| Successful sync history | 1 day, plus newest outcome per function | 4,096 rows per hourly cleanup |
| Failed sync history | 30 days, plus newest outcome | Same cleanup |
| Private `l1:` broadcasts | 1 day | 4,096 rows per hourly cleanup |
| Scheduler transitions | 7 days | 512 rows per hourly cleanup |
| Live checkpoint and attempt state | Deleted with the game | One row per game; no separate failure history |
| Official game statistics and results | No automatic expiry | Product history remains durable |

Cleanup preserves active work, required failure evidence, and protected newest outcomes.
It respects pause and skips locked rows.
Backlogs can outlast their nominal age windows because deletion is bounded.
Deleted space becomes reusable after maintenance; file size need not shrink.
Other managed Realtime topics retain provider policy.

## Memory and connections

The lab caps its database cgroup at 192 MiB with swap available.
The selected runtime settings are 32 MB shared buffers and a PostgREST pool of two.
These are separate from the fixture size and Supavisor pool.
The final sample reaches 135,335,936 bytes of anonymous memory and 48,803,840 bytes of shared memory.
Component peaks can occur at different times; do not sum them as one observed peak.
The budget's maximum sampled container memory is 200,069,120 bytes.

The sample records 18.99 new sessions per minute.
After expected local health probes and measured cron starts, the residual is 11.99/minute.
The PostgREST pool persists; short Auth sessions remain necessary for private reads.
See [hosted settings and lab results](live-scores.md).

## Capture a growth window

Use the same server, source, fixture, and request mix at both ends.
Capture after warmup and again after scheduled retention.
Record elapsed wall time separately from simulated time.

```sh
node scripts/db-health/index.mjs --output ../evidence/day-zero.json
node scripts/db-health/index.mjs --output ../evidence/day-two.json
node scripts/db-health/index.mjs --compare ../evidence/day-zero.json ../evidence/day-two.json 180
```

The last argument is an example projection horizon, not measured season duration.
An accelerated replay must supply its actual simulated interval to the comparison.
The command rejects another database, another server start, or reversed times.
Keep negative allocation changes visible.
Measure table, index, TOAST, WAL, and retained operational history separately.
Allow additional storage for WAL, backups, and maintenance.

## Decision limits

The [Free-plan budget](live-scores.md#free-plan-budget) projects ten phones for 180 hours per month.
It does not establish a supported production user count or billing outcome.
Hosted settings, actual compressed egress, and sustained provider behavior require rollout read-back.
Older multi-gigabyte memory recommendations and restored-backup forecasts do not describe this architecture.
Use current measured rows per completed game and retained history before choosing a storage plan.

## Diagnose queue stalls

Inspect `work_dashboard()`, expired leases, cron outcomes, locks, and the age of the oldest due item.
A cron startup timeout does not identify an inner SQL statement.
Capture the complete error context, wait samples, and resource metrics before assigning a cause.
An empty failed transaction does not prove that no work ran.

Enqueue reuses existing active work before attempting a unique insertion.
The unique index remains the final duplicate guard.
Dispatch starts one item at a time and stops admitting work at its time limit.
A blocked HTTP queue insertion is different from a slow remote response.
Forecast publication does not invalidate an unrelated screen-refresh queue row.
Refresh timestamps and expired trade values alone do not create changed screen input.

Use `tests/db/dispatch-short-work.sql` when changing dispatch admission.
The [database runbook](../supabase/RELEASE-DB.md#worker-incident-controls) owns pause and recovery.
