# Auto-set daily

Auto-set daily fills unlocked starter slots before tipoff for enabled teams. This document defines scheduling, locks, retries, authority, and recovery.

## Team setting

The lineup screen has one switch for the current team and season.
The default-on migration enables existing teams once. New teams start enabled.
Managers can turn the switch off. Later seasons keep that choice.
Today, Whole week, and Rest of season remain manual actions.
Enabling automation takes effect at the next eligible dispatch and does not rewrite future dates.

## Schedule and locks

The scheduler checks each minute. It dispatches when a future tipoff is within two minutes.
Games with the same tipoff share one dispatch across all enabled teams.
The open window also checks a fingerprint of rosters, injuries, games, scoring, slots, and projection inputs.
Changed inputs open a new revision. Unchanged inputs do not repeat a completed run.
The window stays open through the first minute after tipoff to handle news at the start.
Each run loads stored injuries and projections for today's Eastern Time date.
Injury status refreshes every 15 minutes on game days.
Career game counts refresh daily for NBA team players.
The worker and `private.pre_tipoff_input_fingerprint` both use `get_league_projection_rows`.
[Source monitoring](source-monitoring.md#projection-readers) defines per-game source precedence and fingerprint inputs.
Only healthy players with games can enter unlocked starter slots.
The solver uses all listed positions, including G, F, and UTIL eligibility.
It maximizes projected points after preserving locked slots.
Zero or missing projections count as zero. Eligible healthy players still fill empty slots at zero projected points.
Negative projections can leave slots empty when that produces a higher total.

The database owns the lock rule. Feed status, scheduled time, recorded start, and recorded game participation establish locks.
A locked player never moves, even if later declared Out or removed from the roster.
An unlocked Out player goes to the bench. Empty slots remain empty when no eligible healthy player exists.
A postponed game supplies no new starters and opens no new tipoff window.
Postponement news can refresh an already open window.
This includes feed rows that keep Scheduled status but carry PPD or postponement text.
The database also rejects a new unlocked starter if the schedule changes during the run.
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
A retry keeps its revision. A real input change starts a new revision with a new token.
A retry skips completed teams, including after a worker loses its response.
The database checks the setting again before writing and rejects fresh unlocked Out starters.
Existing lineup RPCs enforce roster ownership, slot counts, eligibility, and locks.
Manual and automatic writes share the existing roster and date locks.
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
```

Use the [benchmark guide](../scripts/bench/README.md) for isolated dispatch and assignment measurements.

## Setting recovery

The retained settings recovery plan first revokes client INSERT/UPDATE privileges on the five approved columns.
It then drops the member/league and season/league composite foreign keys, followed by their parent unique indexes.
Keep the original foreign keys, rows, RLS, table grants, and triggers.
Use one bounded transaction and verify inconsistent tuples before reapplication.
Published migration `supabase/migrations/20261008000002_optimizer_setting_context_writes.sql` defines the exact objects and original grants.
Recovery must follow the attested release process. Do not edit applied migrations.
