# Roster lifecycle

Database rules preserve ownership, history, and reservations during roster changes. This contract defines cleanup, waivers, add limits, taxi eligibility, trade plans, and playoff structure.

## Relationship map

A roster row is `roster_players (league, season, member, player, is_on_ir, is_on_taxi)`.
Every other roster-linked record falls into one of three classes.

| Record | Class | Rule when the player leaves the roster or becomes inactive |
| --- | --- | --- |
| `trade_block_items` (player) | live state | Removed when ownership ends or the player enters IR/taxi. Only active roster players can be listed. |
| `trade_block_items` (pick) | live state | Removed when the pick changes owner or is used in a draft. |
| `weekly_lineups` (future, unlocked dates) | live state | Cleared for that member and player. Rows for started or finished games stay for scoring. |
| `waiver_claims` pending `drop_player_id` | live state | Legacy claims lose the stale drop reference. Opted-in trade-plan leagues cancel the claim with a reason. Pending drop reservations restrict IR/taxi moves. |
| `trades` pending with the lost asset | live state | Expired with `completion_failure_reason` and a `trade_expired` activity row. Inactive assets follow the league setting and settlement checks. |
| `trades` accepted | reservation | Deletes and IR/taxi moves of reserved players are rejected; a reserved pick cannot be used in a draft or change owner until the trade completes or is vetoed. |
| `roster_transactions`, `waiver_wire_log`, succeeded `waiver_claims`, `league_activity` | history | Never deleted. A succeeded claim keeps its drop player. A player merge re-points the surviving identity and closes an open waiver entry whose player is rostered under it. |
| `weekly_add_counts`, `faab_balances`, `waiver_priorities`, `standings` | member/season state | Not player-linked; unchanged. |
| `nominations`, `bids`, `snake_draft_picks` | draft history | Unchanged. |
| Client caches | derived | Refresh through the owning loader on focus and relevant changes; [architecture](architecture.md#change-hints) defines league hints. |

## Enforcement

Roster and pick triggers synchronize linked state inside the ownership transaction.
They clear future unlocked lineups and stale listings, then expire dependent offers.
Past-season removals do not clear current live state.
Accepted trade assets remain reserved until settlement or a terminal outcome.
Waiver and trade-plan reservations share team and player locks.

`private.lineup_game_started` owns the database lock predicate.
`private.is_ir_designation` owns IR injury eligibility.
Player merges preserve history under the surviving identity and reject unresolved ownership conflicts.
The [backend inventory](supabase-backend-route-inventory.md) maps public action paths.

## IR activation and swaps

Direct free-agent adds and waiver claims can place eligible players straight into IR.
Straight-to-IR and straight-to-taxi adds are always available without a league opt-in.
An activation can swap an IR player with an eligible active player when both groups are full.
The server checks the final roster and applies both moves in one transaction.
A failed move leaves both players in their original places.
Game locks and trade or waiver reservations still apply.

## Waiver window

A dropped player becomes eligible to clear 48 hours after the drop.
The daily worker processes claims at 03:00 Eastern Time.
Until processing, the player stays on waivers.
`prevent_uncleared_waiver_free_agent_add` rejects free-agent adds for any uncleared entry with SQLSTATE `PA002`.
The add RPC checks the wire before roster capacity.
The trigger backs up other inserts.
`create_waiver_claim_atomic` accepts claims on uncleared entries, including entries past their clearance time.
League-wide reads hide expired uncleared entries, so clients can initially show a free agent.
Every pickup entry point uses `PA002` to offer the claim flow.
`npm run test:db:waiver-window` checks add rejection, claims before processing, rejection after processing, and worker pickup.

## Weekly add limits

`weekly_add_limit` caps free-agent adds and successful waiver claims per add week.
`private.assert_weekly_add_available` checks capacity during free-agent adds, claim submission, and successful waiver processing.
`drop_and_add_free_agent_atomic` reaches that guard through `add_free_agent_atomic`.

Add weeks follow `season_weeks` in Eastern Time, as defined by `private.add_week_timezone`.
Counts reset at midnight after the scheduled week ends.
Dates before the first scheduled week belong to that week.
After the final scheduled week, counts roll every seven days from the next day.
A new season without a schedule keeps the prior season's cadence.
`private.current_add_week` returns the week number and reset instant.
`current_add_week_number` supplies the counter's week number.

The server returns the used count, reset instant, and rejection reason.
The client treats an ended cached week as eligible for a new server check.
Commissioner overrides change the count without changing its reset boundary.

## Verification

```sh
npm run test:db:roster-lifecycle
npm run test:db:roster-oracle
npm run test:db:weekly-add-limit
npm run test:db:waiver-window
npm run test:db:dynasty-rules
npm run test:db:trade-roster-plans
npm run test:db:trade-plan-concurrency
npm run test:db:general-brackets
```

The roster oracle checks ownership, cleanup, history, reservations, and league boundaries after generated actions.
Run these checks against an isolated migrated stack.

## Trade window

Trades stay open in offseason, the rookie draft, the active season, and playoffs.
Setup and the startup auction close trading.
The server checks this window when managers propose, accept, or settle trades.
A commissioner trade deadline blocks new offers after that date.
Pending offers remain private to their parties.
The public activity feed omits offers, counters, edits, expirations, and trade-block changes.
Completed trades remain visible with participant names.
New NBA rookies cannot enter free-agent adds or waiver claims before the league completes its rookie draft.

## Draft pick years

The database stores each pick by fantasy `season_year`.
Its rookie draft occurs in the summer of `season_year - 1`.
Pick labels and server messages use that calendar draft year.
For current season 2027, the three future classes are stored as 2028–2030 and displayed as 2027–2029.

League creation and member joining allocate three rounds for each of those three future classes.
A normal season advance adds exactly one new future class and preserves existing owners.
It retains the current rookie class for the upcoming draft.
A skipped-year advance fills missing current and future classes without changing historical picks.
Setup rollover shifts existing assets with the season and keeps the same three-class window.
Draft reset and reseeding reuse existing pick assets.
Mock drafts create slots without creating owned pick assets.

Only three future classes can enter trades.
Unused current-class picks retain the existing offseason and live-draft restrictions.
Cleanup deletes distant picks only when they are unused and have no references, including activity history, or rookie draft assignment.
Referenced distant picks remain stored, but cannot enter new trades until their class reaches the window.

## Taxi eligibility and trade plans

Every league uses one taxi rule: `years_exp = 0` or fewer than 65 career NBA regular-season games.
Draft position does not affect eligibility.
An undrafted rookie qualifies.
A second-year player with 64 games qualifies.
A nonrookie needs a known count to enter taxi.
An unknown count never makes an existing taxi player illegal.
The server counts played regular-season box scores from 2020-21 onward.
A played game requires positive minutes and `did_not_play = false`.
The counter adds a stored prior for games before our coverage starts on December 22, 2020.
Experience and the first stored season identify players whose prior is zero.
Players with at least 65 observed games need no outside lookup for taxi decisions.
Their stored count is a lower bound until a prior is known.
Older players below 65 observed games need one verified ESPN prior.
Failed lookups retry no more than weekly.
A successful prior never triggers another career-stat lookup.
Unknown priors keep the total unknown below 65 games.
Stats saves, corrections, deletions, game corrections, and player merges recount within their transaction.
Replays do not add games twice.
The old daily Edge writer remains callable; its count cannot replace the server recount.

The server stores career regular-season games in `players.career_regular_season_games`.
Career counts refresh daily for NBA team players.
The phone uses stored experience and career counts for display-only Rookie and Taxi tags.
Rookie means `years_exp = 0`; Taxi also requires the league to have taxi slots.
The server remains authoritative for every roster action.
An unknown count hides the Taxi tag unless `years_exp = 0`.
Game-day injury refreshes run separately every 15 minutes.

`taxi_start_season_year` records the first taxi season. Trades and season carryover retain that value.
A missing start uses the earliest recorded taxi roster or acquisition season. Drops and later draft acquisitions do not restart that clock.
With `taxi_max_seasons = 2`, the third season promotes the player during the existing rollover.
The player stays owned. An overflowing active roster blocks restricted acquisitions and trades.
Existing lineup capacity checks still apply.
A taxi exit still prevents a return to that team's taxi.
Players must stay eligible while on taxi.
New game counts or experience can make a taxi roster illegal.

Eligible players can enter taxi through drafts, trades, free-agent adds, or waiver claims.
Straight-to-taxi adds check eligibility, slots, tenure, and prior exits.
Accepted trades hold their incoming taxi slots until settlement.
Adds cannot use those slots, and claims fall back to active space or their planned drop.
An add cannot request both IR and taxi.
IR stays the automatic destination for eligible Out free agents.
Straight-to-taxi adds remain allowed after the player's game starts.
A `to_taxi` claim checks taxi placement again when the worker processes it.
If taxi placement fails, the claim uses active roster space or its planned drop.
If neither fits, the claim fails with a clear reason.
Claim edits preserve the stored taxi choice when the caller omits it.

## Legal roster gate

An ineligible IR player, ineligible taxi player, or excess active player makes a roster illegal.
The server names ineligible IR and taxi players.
It reports active roster excess once for the team.
`PA003` identifies active roster overflow.
`PA005` identifies ineligible IR players.
`PA009` identifies ineligible taxi players.
The server blocks free-agent adds, new claims, claim edits that add, sent trade offers, and trade acceptance.
Pending claims fail during processing while the roster remains illegal.
Managers can activate IR or taxi players, move eligible players to IR, drop players, or cancel claims and offers.
The acquisition guard does not block lineup edits, activations, or drops.
Existing lineup capacity, reservation, and game-lock checks still apply.
The Roster banner offers actions that make the team legal.

## Trade plans

Legacy trades can complete above the active roster limit.
That owner can drop players and keep scoring existing lineups.
The legal roster gate blocks new offers and acceptance until the active count fits.
During the rookie draft, an over-limit team must use taxi, IR, or a drop before sending or accepting a trade.
Free-agent adds and starting-lineup edits require the active count to return within the limit.

`allow_inactive_trades` enables IR and taxi assets and strict trade plans.
Each manager chooses incoming IR/taxi destinations and planned drops while the offer is pending.
The proposer can include the plan in the existing idempotent submission payload.
Counterparties can save choices before acceptance or submit choices with acceptance.
Every participant must accept before settlement.
League review settings select immediate processing, commissioner review, or member voting.
Acceptance stores and checks the plan. It changes no roster.
Settlement checks every participant again, then applies all drops and transfers in one transaction.
A failed transaction restores assets, drops, placements, waiver entries, and tenure.
Vetoes, rejection, withdrawal, and expiry apply no roster changes.
Taxi assets retain taxi placement and tenure. IR assets enter the active roster unless the receiver chooses eligible IR placement.
Only Out or IR-designated incoming players can enter IR.

The active limit remains `roster_size`, which includes starters and bench players.
The total limit is `roster_size + ir_slots + taxi_slots`. IR and taxi also have separate limits.
Trades do not place incoming players into lineup slots. Existing lineup validation controls the configured starter slots.
Capacity uses the full plan, including outgoing players and chosen drops, for all participants.
Drops happen only at settlement. They use the existing release function and enter 48-hour waivers.

Pending planned drops block other pending trade assets, other planned drops, and active waiver drops.
The reverse checks apply to plan creation. Shared team locks and sorted player locks serialize reservations.
Accepted assets and drops remain reserved through settlement or a terminal outcome.
Ownership cleanup expires dependent offers with their existing visible failure reason and notification outbox.
For opted-in leagues, a pending claim whose drop leaves the roster becomes cancelled with an explicit reason.

## Flexible playoff rounds

Explicit playoff entrants use a full seeded elimination tree with `ceil(log2(entrants))` rounds.
Top seeds receive first-round byes.
Each round starts after the previous round's configured weeks.
Calendar validation counts skipped weeks as elapsed time.

The season stores explicit seeds in `playoff_bracket_seed_ids`.
Matchups store `playoff_round` and `playoff_position`.
These fields drive advancement and freeze consumed results, including consecutive early rounds.
Matchup types label early rounds, semifinals, and the final.

Null entrant settings retain the legacy four- or six-team bracket and original seed snapshot.
The legacy array constraint remains intact.
Migration does not assign new seed snapshots to existing seasons.
