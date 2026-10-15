# Auto-set daily

The lineup screen has one switch for the current team and season.
The default rollout enables every existing team in its current season once.
New teams start with Auto-set daily on.
Managers can turn the switch off. Later seasons keep that choice.
The switch keeps the existing owner checks and season boundaries.
Today, Whole week, and Rest of season remain manual actions.
Turning on daily automation does not rewrite future dates.
It takes effect at the next eligible dispatch.

## Schedule and locks

The scheduler checks each minute. It dispatches when a future tipoff is within two minutes.
Games with the same tipoff share one dispatch across all enabled teams.
The open window also checks a fingerprint of rosters, injuries, games, scoring, slots, and projection inputs.
Changed inputs open a new revision. Unchanged inputs do not repeat a completed run.
The window stays open through the first minute after tipoff to handle news at the start.
Each run loads current injuries and projections for today's ET date.
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

## Rollout and rollback

Deploy the Edge function, then apply `20261014000001_pre_tipoff_lineups.sql`.
The new code still supports the old scheduler.
No preference backfill runs. No existing setting or lineup is deleted by the migration.
The migration adds two internal ledgers, an index, and service-only functions.
It changes the existing cron job to the new predicate.

Run `supabase/rollbacks/20261014000001_pre_tipoff_lineups_rollback.sql` to restore the ten-minute job.
The rollback fences existing claims and keeps all data and additive schema. The old predicate and Edge path remain callable.
Restore the scheduler and let the current tipoff window end before rolling back the Edge deployment.
The old scheduler resumes its old behavior, including future-date optimization and its first-tipoff day gate.

## Default rollout

Apply `20261014000002_default_daily_lineup_optimizer.sql` once after the scheduler migration.
It enables all current teams and sets the database default to true.
Member and season triggers create settings for league creation, invite joins, and season changes.
Later seasons copy each manager's previous choice. Existing settings keep explicit false values.
The migration changes no lineups. The switch uses the existing owner mutation.
