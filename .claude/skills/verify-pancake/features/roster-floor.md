# Weekly roster floor

A league whose `private.league_roster_policies.weekly_roster_floor` is set runs one weekly job on the last day of its scheduled week.
The job first applies the existing legal Auto IR resolution to every team, then brings every team with fewer than the floor active players up to exactly the floor with the best remaining free agents.
IR and taxi do not count toward the floor. Teams at or above the floor are never touched.
No other league changes behavior.

## Sub-features

- `roster-floor-counts` fills teams at 14 and 15 to 16 and leaves teams at 16 and 17 alone.
- `roster-floor-order` shuffles every member once per week, stores the order, and awards one player per team per pass; teams at or above the floor are skipped at award time.
- `roster-floor-pool` ranks unrostered free agents with a current-season league-scored average, an NBA team, and no injury designation by the league’s fantasy points per game.
- `roster-floor-waivers` waits for the week’s final waiver run and every due claim, and never re-awards a claimed player.
- `roster-floor-games` defers while an NBA game is in progress (including a stale feed past tip-off) and never adds a player whose game has started.
- `roster-floor-ir` applies healthy IR returns before counting and leaves a full injured IR unchanged.
- `roster-floor-reservations` skips trade-reserved players and respects accepted-trade capacity.
- `roster-floor-schedule` enqueues and dispatches the job from the real schedule and retries a deferred week every 15 minutes.
- `roster-floor-retry` keeps an unfinished week `pending` with `last_deferral_reason` and `last_deferred_at`, retried by both the dispatcher and `process-waivers`; it completes late when its prerequisites clear before the next matchup week's run is due, and otherwise becomes `expired` with `expired_at` while the next week runs normally.
- `roster-floor-settlement` runs the floor only after `private.waiver_run_settlements` records the week-end run; later claims and later-clearing holds do not block it, a claim due that day does, and a completed week never refills.
- `roster-floor-revalidation` rechecks the player after the locks, awards the next legal player after a scratch, a new claim or a tipoff, and treats a Postponed game as not live.
- `roster-policy-activation` keeps the policy inert until `private.activate_league_roster_policy(league_id)` sets `floor_activated_at` and `ir_activated_at` together. No worker, migration, or scheduler activates it, so an all-manual league starts only after the documented step.
- `roster-floor-averages` defers with `averages_pending` and awards nobody when the league season's average cache is uninitialized, its scoring no longer matches the league, or a stats correction left dirty rows. It takes no row lock; it captures a cache watermark (row count, latest refresh time, latest version) at preflight and rechecks readiness and the watermark after every award and before completion, rolling the whole pass back on a change.
- `roster-floor-ir-transient` defers with `ir_transient` and rolls back the whole pass when a member's IR return fails transiently, so it never awards a free agent ahead of a healthy legal IR return.
- `roster-floor-atomic` rolls back the whole pass, including the IR returns and awards, when a game starts mid-pass, so the retry recomputes from current state and keeps the round-robin order.
- `roster-floor-membership` locks the league's member rows before the pass, drops a departed member from the stored order, appends a member who joined while the week was pending, and keeps surviving teams in their stored relative order.
- `roster-floor-midnight` settles and runs the week from the database clock crossing the league-local midnight, not from a passed-in future timestamp.

## How to get to it (user POV)

- Roster → the team shows 16 active players after the week’s run.
- Activity → the roster transaction records each `fa_add`.
- Waivers → the claimed players are not re-awarded by the floor.

## Driving it with agent-browser

Preconditions:

- A fresh disposable stack launched from this branch.
- `node tools/verify/seed-roster-floor.mjs "$EVIDENCE" --count=14` has run.
- Read the involved player names and ids from the seeder’s JSON, not from the fixture.

- **Seed.** Run the seeder for one count. It sets the fixture league’s floor policy and activates it through `private.activate_league_roster_policy`, reshapes E2E Team 1 to the requested active count, fills the other teams to 16, and creates six free agents with real `player_game_stats`. It builds the averages cache through `private.refresh_queue_screen_views` and `private.refresh_player_averages`, records the week’s settlement through `private.settle_waiver_runs`, and prints JSON with `activated`, `averagesReady`, `weekReady`, and `settled`. It fails unless all four are true. Re-running the same count resets and reapplies it.
- **Before.** Run `node tools/verify/observe.mjs "$EVIDENCE" > "$EVIDENCE/roster-floor-before.json"`. Require E2E Team 1’s active count and the free agents’ `player_season_averages`.
- **Trigger.** Run `node tools/verify/trigger-roster-floor.mjs "$EVIDENCE"`. It posts to the local `process-waivers` Edge route with the run’s generated internal token and prints the week record, team counts, and the `before`, `after`, and `delta` counts for the fixture league and every league. The token is never printed. It exits non-zero when the week record is not `completed`, so a deferral is a visible failure.
- **After.** Repeat the observation into `roster-floor-after.json`. Require E2E Team 1 at 16 active, two `fa_add` transactions, and the week record `completed`. Require `delta.awards`, `delta.transactions`, and `delta.rosterPlayers` equal to the expected add count (2 for 14, 1 for 15, 0 for 16 and 17). Require every other league’s `delta.leagues` entry to show zero `rosterPlayers` and zero `faAddTransactions`.
- **Roster screen.** Open Roster and require 16 active players. The added players use `acquired_via = 'roster_floor'`.
- **Repeat.** Run the trigger again. Require `delta.awards: 0`, `delta.transactions: 0`, `delta.rosterPlayers: 0`, and every `delta.leagues` entry at zero.
- **Widths.** Repeat the Roster check at 375×812.

## Expected results

| Count | Stored result | Visible result |
| --- | --- | --- |
| 14 | 16 active, two `fa_add` rows | Roster shows 16 |
| 15 | 16 active, one `fa_add` row | Roster shows 16 |
| 16 | 16 active, no add | Roster shows 16 |
| 17 | 17 active, no add | Roster shows 17 |

## Database recipes

Run these on the disposable stack before the visible journey:

- `npm run test:db:roster-floor`, `npm run test:db:roster-floor-schedule`, `npm run test:db:roster-floor-settlement`, `npm run test:db:roster-floor-revalidation`, `npm run test:db:roster-floor-membership`, `npm run test:db:roster-floor-membership-concurrency`, and `npm run test:db:roster-floor-concurrency` cover counts, order, pool, waivers, games, IR, reservations, schedule, settlement, revalidation, membership changes, and repeat runs.
- `npm run test:db:r4-floor-atomic` holds the second-ranked free agent’s lock, lets the first team take the first free agent, crosses an unrelated game’s start, and requires the deferred pass to commit no awards and the retry to keep the round-robin order.
- `npm run test:db:r3-cases` includes the midnight case: the fixture league’s timezone is chosen so the database clock is already the next day there while the settlement date is the previous day, and the scheduler admits the floor from that clock.
- `npm run test:db:r5-cases` covers the averages gate (scoring change, delayed refresh, uninitialized cache, exact tie), the explicit activation, and the scoped pre-tipoff lease.
- `npm run test:db:r5-red` is the base-compatible red probe for the same findings.
- `npm run test:db:r5-ir-transient` holds a real player row past the service lock timeout and requires the floor to defer with no awards, then complete after the released retry.

## Gotchas

- The seeder is destructive to the fixture league; recreate the run before unrelated roster journeys.
- The seeder sets the fixture league’s `scoring_settings` to a standard scoring object so the refreshed averages are real and ranked; the fixture league otherwise defaults to `{}` and every average would be zero.
- The seeder refreshes `public.mv_player_season_averages` before `private.refresh_player_averages`, because the cache reads that materialized view.
- The floor only runs on the league-local `week_end` day after the league’s local midnight. The seeder sets the fixture league’s timezone to `Pacific/Kiritimati` so the run is due immediately.
- The seeder fills the other teams to 16 so only E2E Team 1 qualifies; otherwise the shuffled order can exhaust the pool before reaching Team 1.
- The seeder deletes the fixture league’s week record and awards so a re-run starts a fresh week.
- The pool excludes no-stats, teamless, day-to-day, questionable and out players; the seeder’s free agents are healthy and scored.
- A live NBA game defers the run; the seeder does not create one.
- The first `browser.sh login` after launch can fail once; the helper retries once.
