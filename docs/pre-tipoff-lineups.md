# Auto-set daily

Auto-set daily fills unlocked starter slots before tipoff for enabled teams. This document defines scheduling, locks, retries, authority, and recovery.

## Team setting

The lineup screen groups its controls in two compact rows.
Today, This week, and Rest of season fill the first row.
Rest of season sets the remaining season dates.
Keep updated automatically and its switch fill the second row.
The whole second row acts as one switch, with the accessible name Keep lineup updated automatically.
The horizontal day row sits directly below these controls and above Starters.
The first-row actions run once and leave the automatic setting unchanged.
Keep updated automatically saves the current team and season preference.
The default-on migration enables existing teams once. New teams start enabled.
Managers can turn the switch off. Later seasons keep that choice.
The panel disables changes when the lineup is read only or offline.
Manual edits remain available by selecting players and slots.
Home and Roster open the same action choices through Auto-set.
Their sheets also offer Edit lineup manually.
An automatic run can replace unlocked manual choices.
Unchanged checks after a completed run leave later manual edits alone.
Enabling automation takes effect at the next eligible dispatch and does not rewrite future dates.

## Schedule and locks

The scheduler checks each minute. Daily work becomes due at 06:00 America/New_York.
An earlier known tipoff moves that time to ten minutes before the game, bounded by Eastern midnight.
A late tick catches up while an available unstarted game remains. TBD games also qualify.
Dates without an available unstarted game enqueue nothing. Disabled teams do not qualify.
The work key and payload use the current Eastern calendar date, including across daylight-saving changes.
Each enabled team records one successful daily check per date in `last_daily_optimized_date`.
The receipt and lineup update share a transaction. Retries and concurrent calls skip completed teams.
A delayed daily call also skips a team with a successful pre-tipoff receipt for that date.
Daily and pre-tipoff share the context, solver, atomic validation, and unchanged-assignment comparison.
No-change checks preserve lineup row IDs and timestamps. Later pre-tipoff news can still change unlocked starters.

Pre-tipoff dispatches when a future tipoff is within two minutes.
Games with the same tipoff share one dispatch across all enabled teams.
The open window also checks a fingerprint of rosters, injuries, games, scoring, slots, and projection inputs.
Changed inputs open a new revision. Unchanged inputs do not repeat a completed run.
The window stays open through the first minute after tipoff to handle news at the start.
Each run loads stored injuries and projections for today's Eastern Time date.
Injury status refreshes every 15 minutes on game days.
Career game counts refresh daily for NBA team players.
The worker and `private.pre_tipoff_input_fingerprint` both use `get_league_projection_rows`.
[Source monitoring](source-monitoring.md#projection-readers) defines per-game source precedence and fingerprint inputs.
The solver uses all listed positions, including G, F, and UTIL eligibility.
It preserves locked slots, then maximizes the number of filled unlocked slots.
It next maximizes healthy playing projections, then the number of healthy playing starters.
Zero or missing projections count as zero.
Out, IR, no-game, and postponed players contribute zero playing points.
Fallbacks can fill otherwise empty slots, including when all available projections are negative.

### Slot assignment

After those three objectives tie, the solver preserves later choices at each tipoff, earliest first.
It counts legal player-slot pairs for healthy roster players whose games start later.
It minimizes pairs lost when earlier starters lock their slots.
Then it minimizes the total position breadth of those locked slots.
Specialist slots accept fewer positions than G, F, and UTIL.
Players with unknown tipoffs count as later until the schedule supplies a time.
Players without games consume no future lock budget.
All positions compete in one matching, so a specialist preference cannot reduce the primary objectives.

Remaining ties prefer occupied specialist slots, existing assignments, healthy fallbacks, then fallback projections.
Sorted player IDs and slot types resolve exact ties deterministically.
Equal simultaneous tipoffs preserve existing assignments when the other objectives tie.
The matching uses separate objective values; it does not mix points and flexibility through a weighted sum.
Its work grows polynomially with roster size, slot count, and distinct tipoff times.

The flexibility measure counts individual legal choices, not every possible future injury combination.
It includes later bench alternatives but cannot predict news, roster additions, or schedule changes.
A later run optimizes again around the slots that have locked.
For example, an early PG takes PG while a later PG takes UTIL.
A later center can then replace that later guard if the guard becomes Out.

The database owns the lock rule. Feed status, scheduled time, recorded start, and recorded game participation establish locks.
A locked player never moves, even if later declared Out or removed from the roster.
An unlocked Out player yields to an eligible healthy player with better playing value.
An Out or no-game player can remain as a fallback under the fill-first policy.
A postponed game supplies no playing value and opens no new tipoff window.
Postponement news can refresh an already open window.
This includes feed rows that keep Scheduled status but carry PPD or postponement text.
The database rejects an expected-active starter if the schedule or injury status changes during the run.
Intentional fallbacks carry `expected_active=false` and remain subject to roster, position, and lock checks.
Existing locks still follow the app's shared database rule, including a scheduled time that has already passed.
A player whose game starts while benched stays benched, including when no lineup row exists for that date.
Games with a TBD tipoff (`game_time IS NULL`) open no dispatch window.
They remain eligible under the existing game-day rules until the feed establishes a lock.
Once the feed supplies a future tipoff, the next minute check can dispatch its window.
If the time stays unknown, no game-triggered run occurs for that game. Manual actions remain available before it locks.
Each later tipoff lets the remaining unlocked players compete for remaining slots.
Optimality uses the inputs read by the run.
The next minute check refreshes changed inputs while the window stays open.
News after the window closes waits for the next tipoff window.
Late delivery can refresh remaining unlocked slots; it cannot move players who already lock.
An outage that lasts through tipoff cannot recover the missed chance to change locked players.

## Retry and authority

A dispatch has one unique tipoff timestamp and a claim token.
A worker claims queued work once. Team transactions keep active work under a 45-second lease.
The worker also renews every fifteen seconds during reads.
It processes pending teams in bounded batches and skips completed receipts before loading context or projections.
Each invocation has at most 110 seconds of work and stops five seconds before the late tipoff window closes.
Lease loss or the work deadline cancels outstanding requests and records a failure.
The next minute retries failed work and expired claims before tipoff.
A new token fences the previous worker.
Each team has one receipt per dispatch revision. The lineup write and receipt share one transaction.
A member failure gets a receipt with its error. Other members continue, and the dispatch finishes successfully.
The response retains the failed count and member errors. Those errors do not fail or retry the work item.
Lease loss, dispatch failures, and failure-receipt write errors still fail the batch and permit recovery.
A retry keeps its revision. A real input change starts a new revision with a new token.
A retry skips completed teams, including after a worker loses its response.
An unchanged revision also skips recorded member failures. New inputs allow those members to run again.
The database checks the setting again before writing and rejects fresh unlocked Out starters marked expected-active.
Existing lineup RPCs enforce roster ownership, slot counts, eligibility, and locks.
Manual and automatic writes share the existing roster and date locks.
Pending offers do not block starter and bench changes. Roster removals, IR and taxi moves retain their reservation guards.
Unchanged assignments preserve row identities and timestamps.
Dispatch tables and RPCs are service-only. Client setting permissions stay unchanged.

## Operations

The scheduler migration is `supabase/migrations/20261014000001_pre_tipoff_lineups.sql`.
The default-on migration is `supabase/migrations/20261014000002_default_daily_lineup_optimizer.sql`.
Both remain published history. Later migrations refine retries and dispatch guards.
Use the canonical functions and current Edge code when checking behavior.

The retained rollback is `supabase/rollbacks/20261014000001_pre_tipoff_lineups_rollback.sql`.
It restores the older scheduler and fences claims while retaining additive schema and data.
It also restores older optimization behavior. Review current migration compatibility before using it.

Owner RLS and composite foreign keys bind each setting to its member, league, and season.
Clients can write only the approved setting columns.
The toggle rejects offline admission and never replays that intent on reconnect.

```sh
npm run test:db:pre-tipoff
npm run test:db:optimizer-default
npm run test:db:optimizer-context
npm run test:db:pre-tipoff-live-concurrency
```

The concurrency recipe overlaps real stats ingestion with optimization and checks completed writes, stable slots, and the resulting score.
Use the [benchmark guide](../scripts/bench/README.md) for isolated dispatch and assignment measurements.

## Setting recovery

The retained settings recovery plan first revokes client INSERT/UPDATE privileges on the five approved columns.
It then drops the member/league and season/league composite foreign keys, followed by their parent unique indexes.
Keep the original foreign keys, rows, RLS, table grants, and triggers.
Use one bounded transaction and verify inconsistent tuples before reapplication.
Published migration `supabase/migrations/20261008000002_optimizer_setting_context_writes.sql` defines the exact objects and original grants.
Recovery must follow the attested release process. Do not edit applied migrations.

## Verify scheduled runs

`work-dispatcher` runs every minute (`* * * * *`).
It calls `dispatch_work`, then `private.enqueue_scheduled_work`.
`private.enqueue_lineup_optimizer` queues date-keyed `lineup-optimizer` work with `mode=daily` and `date`.
`private.enqueue_pre_tipoff_optimizer` queues `pre-tipoff` work with `mode=pre_tipoff`.
Both use the `lineup-optimizer` Edge function. There is no additional cron job.
The daily path is introduced by `20261214009500_daily_lineup_optimizer.sql`.
Check `last_daily_optimized_date` to confirm each team's completed daily check.
Failed teams remain eligible for a work-queue retry; completed teams are not rewritten.
The manual Today, This week, and Rest of season actions use the date optimizer.

After deployment, run these read-only queries in the project's SQL editor.
Check worker and team receipts as well as the cron result.
A successful cron tick only confirms dispatch work completed.

```sql
BEGIN READ ONLY;
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;
SELECT d.runid, d.start_time, d.end_time, d.status, d.return_message
FROM cron.job_run_details d JOIN cron.job j USING (jobid)
WHERE j.jobname = 'work-dispatcher'
ORDER BY d.start_time DESC LIMIT 30;
SELECT id, kind, status, due_at, completed_at, attempts, last_error
FROM private.work_items WHERE kind IN ('pre-tipoff', 'lineup-optimizer')
ORDER BY id DESC LIMIT 30;
SELECT league_id, league_season_id, member_id, enabled, last_daily_optimized_date, last_optimized_at
FROM public.lineup_optimizer_settings ORDER BY last_optimized_at DESC NULLS LAST LIMIT 100;
SELECT tipoff_at, game_date, status, attempts, input_revision, finished_at, error
FROM public.lineup_tipoff_dispatches ORDER BY tipoff_at DESC LIMIT 30;
SELECT tipoff_at, member_id, input_revision, completed_at, error
FROM public.lineup_tipoff_members ORDER BY completed_at DESC LIMIT 100;
SELECT id, started_at, finished_at, status, rows_affected, error
FROM public.sync_runs WHERE function_name = 'lineup-optimizer'
ORDER BY started_at DESC LIMIT 30;
SELECT id, queued_at, worker_status, status_code, error_message, sync_run_id, work_item_id
FROM public.edge_invocations WHERE function_name = 'lineup-optimizer'
ORDER BY queued_at DESC LIMIT 30;
ROLLBACK;
```

Use `work_item_id` and `sync_run_id` to connect dispatch and worker records.
Use tipoff time, member ID, and input revision to find each team's outcome.
Existing retention rules can remove older attempts; current player status does not establish status at a historical run.
