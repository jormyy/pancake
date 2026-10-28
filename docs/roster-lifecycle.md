# Roster lifecycle

Database rules preserve ownership, history, and reservations during roster changes. This contract defines cleanup, waivers, add limits, taxi eligibility, trade plans, and playoff structure.

## Relationship map

A roster row is `roster_players (league, season, member, player, is_on_ir, is_on_taxi)`.
Every other roster-linked record falls into one of three classes.

| Record | Class | Rule when the player leaves the roster or becomes inactive |
| --- | --- | --- |
| `trade_block_items` (player) | live state | Removed when ownership ends. IR/taxi listings require the inactive-trade setting and survive roster-location changes. |
| `trade_block_items` (pick) | live state | Removed when the pick changes owner or is used in a draft. |
| `weekly_lineups` (future, unlocked dates) | live state | Cleared for that member and player. Rows for started or finished games stay for scoring. |
| `waiver_claims` pending `drop_player_id` | live state | Legacy claims lose the stale drop reference. Opted-in trade-plan leagues cancel the claim with a reason. Pending drop reservations restrict IR/taxi moves. |
| `trades` pending with the lost asset | live state | Expired with `completion_failure_reason` and a `trade_expired` activity row. Inactive assets follow the league setting and settlement checks. |
| `trades` accepted | reservation | Deletes and IR/taxi moves of reserved players are rejected; a reserved pick cannot be used in a draft or change owner until the trade completes or is vetoed. |
| `roster_transactions`, `waiver_wire_log`, succeeded `waiver_claims`, `league_activity` | history | Never deleted. A succeeded claim keeps its drop player. A player merge re-points the surviving identity and closes an open waiver entry whose player is rostered under it. |
| `weekly_add_counts`, `faab_balances`, `waiver_priorities`, `standings` | member/season state | Not player-linked; unchanged. |
| `nominations`, `bids`, `snake_draft_picks` | draft history | Unchanged. |
| Client caches | derived | Refresh through the owning loader on focus and relevant changes; [architecture](architecture.md#versioned-cache-and-push-invalidation) defines league hints. |

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

## History lock

Roster moves preserve past dates, completed slates, and locked slots.
A completed slate stays unchanged even when a player has no known NBA team.
Only future slots with unstarted games can clear.
A saved lineup receipt keeps its original row before a player changes NBA teams.
This keeps the lock when a box score or participation record is missing.
Drops, IR, taxi, trades, and waiver results share the cleanup rule.

The history repair restores missing rows from complete saved receipts.
It preserves each row ID, slot, date, and timestamp.
It skips conflicts, missing identities, and seasons whose score inputs are retired.
Each restored row creates a `lineup.history_restored` league event.
A repeated repair restores zero additional rows.
Rows lost before receipts exist require separate evidence; the repair does not guess their slots.

## IR activation and swaps

Scheduled waiver claims can place eligible players straight into IR.
Straight-to-IR and straight-to-taxi claim destinations need no extra league opt-in.
An activation can swap an IR player with an eligible active player when both groups are full.
The server checks the final roster and applies both moves in one transaction.
A failed move leaves both players in their original places.
Game locks and trade or waiver reservations still apply.

## Continuous waivers

Every available player requires a scheduled claim. No ordinary pickup changes ownership immediately.
The worker awards claims at midnight in `leagues.timezone`, including daylight saving changes.
The dispatcher creates one dated waiver task per timezone and checks due work each quarter hour.
Daily trade-value work remains independent of those waiver tasks.
The default timezone is `America/Los_Angeles`. Run labels show `12:00 AM PT` there.
Commissioners can change the timezone. Open holds and pending claims then follow its midnight.
Home, Roster, and waiver labels use that same league date.
NBA scoring dates and weekly add boundaries retain their Eastern calendar rules.
A claim submitted at the cutoff waits until the next daily run.
Dropped players also complete their 48-hour hold before an eligible scheduled run.
The server rejects instant-add RPCs and direct free-agent inserts with SQLSTATE `PA002`.
Claims do not require a waiver-wire entry when the player is unowned.

The highest valid FAAB bid wins. Equal bids use rolling team priority, then that team's claim order.
Successful winners move behind other teams. Zero-dollar bids remain valid.
Only a successful award spends FAAB or consumes an add. Its conditional drop occurs in the same transaction.
Accepted-trade FAAB reservations reduce the available balance.
Creation, editing, reordering, and cancellation preserve private bids.
The scheduled cutoff freezes edits, reordering, and cancellation while a worker is delayed.
Retries and overlapping workers cannot award the same player twice.

Players exposes Players, Waivers, Rankings, and News in that order.
Waivers loads when opened and shows available FAAB, the next run, priority, pending claims, and recent results.
Player rows and profiles open the shared claim form. Pending claims link back to Waivers.
The shared form also edits bids, destinations, and conditional drops.

`test:db:continuous-faab` checks pending ownership, awards, balances, priority, retries, and stale-client rejection.
`test:db:continuous-faab-schedule` checks cutoff and daylight saving boundaries.

## Weekly add limits

`weekly_add_limit` caps successful waiver claims per add week.
`private.assert_weekly_add_available` checks capacity during claim submission and successful waiver processing.
Legacy instant-add calls fail without dropping or acquiring a player.

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

## Retries

Each write below gets a UUID before it enters the offline queue or sends a request.
Transport retries keep that UUID and the original payload.
The client retries a lost connection once, including a failure while reading the response body.
A new action gets a new UUID.
Queue records can restore the same UUID through `withPwaMutation` options.
The offline queue persists input and request IDs without access tokens.
It holds the PWA update guard while work remains pending.
A failed replay blocks later actions until retry.

The API requires `x-request-id` on POST requests.
It forwards the ID with the verified user to database calls and internal lineup optimization.
Database calls use the authenticated user, even if a caller supplies another actor header.
Service calls accept an actor from the trusted server.
Internal jobs without a client action keep their existing behavior.

`private.request_receipts` stores the actor, function, input hash, result, and creation time.
One transaction lock serializes calls with the same ID.
The write and its receipt commit together.
A repeat returns the first result before it checks changed roster or draft state.
Reusing an ID for another actor, function, or payload fails.
A failed transaction leaves no receipt.
A corrected action uses a new ID.
Trade quote regeneration does not change the action identity.

Nested atomic calls share the outer receipt.
Season optimization derives a stable child ID for each member and date.
Its first committed assignment wins if a retry recomputes projections.
The existing retention job removes receipts older than seven days in bounded batches.
Clients cannot read or change receipts directly.

Each write-family recipe overlaps two sessions, repeats the action twice more, and checks equal results and one receipt.
Row triggers record the writes and prove that retries add none.
The settings recipe disables the guard as a negative control and requires the check to fail.

| Write paths | Guarded database entry points | Proof |
| --- | --- | --- |
| Lineup moves and auto-set | `set_player_slot_atomic`, `set_player_slot_moves_atomic`, `auto_set_lineup_atomic`, `auto_set_lineup_service_atomic`, `update_lineup_slots_atomic` | [Lineup recipe](../tests/db/idempotency-lineup.sql) |
| Claim create, edit, cancel, reorder | `create_waiver_claim_atomic`, `edit_waiver_claim_atomic`, `cancel_waiver_claim_atomic`, `reorder_waiver_claim_atomic` | [Claims recipe](../tests/db/idempotency-claims.sql) |
| Trade propose, edit, counter, accept, reject, withdraw, veto, vote | `submit_trade_offer_atomic`, `propose_trade_atomic`, `propose_multi_team_trade_atomic`, `accept_trade_atomic`, `accept_trade_with_plan_atomic`, `reject_trade_atomic`, `withdraw_trade_atomic`, `veto_trade_atomic` | [Trades recipe](../tests/db/idempotency-trades.sql) |
| Trade roster plans, destinations, and block | `set_trade_roster_plan_atomic`, `set_trade_taxi_destinations_atomic`, `add_trade_block_item_atomic`, `remove_trade_block_item_atomic` | Shared receipt guard; [client guard inventory](../tests/lib/api-client.test.ts) |
| Draft picks, nominations, bids | `make_snake_pick_atomic`, `auto_pick_snake_pick_atomic`, `commissioner_snake_pick_atomic`, `create_auction_nomination_atomic`, `place_auction_bid_atomic`, `withdraw_auction_nomination_atomic` | [Draft recipe](../tests/db/idempotency-draft.sql) |
| IR, taxi, activation, drop | `toggle_ir_atomic`, `toggle_taxi_atomic`, `activate_roster_player_with_lineup_atomic`, `activate_roster_player_with_overflow_atomic`, `drop_player_atomic` | [Roster recipe](../tests/db/idempotency-roster.sql); short drop overloads delegate to the guarded entry |
| Legacy instant adds | `add_free_agent_atomic`, `drop_and_add_free_agent_atomic` | Shared guard; existing continuous-waiver rejection stays in force |
| League, lineup slot, team, notification, and optimizer settings | `update_league_settings_atomic`, `update_league_configuration_atomic`, `update_lineup_slots_atomic`, `save_client_settings_atomic`, `commissioner_adjust_faab_balance_atomic`, `commissioner_override_weekly_add_count_atomic` | [Settings recipe](../tests/db/idempotency-settings.sql) |
| Announcements | `notif_publish_announcement_atomic` | [Announcements recipe](../tests/db/idempotency-announcements.sql) |
| League create and join | `create_league`, `join_league_by_invite_code` | [Leagues recipe](../tests/db/idempotency-leagues.sql) |
| Failed requests, actor and input binding, retention, permissions | Shared receipt helpers | [Core recipe](../tests/db/idempotency-core.sql) |

Run each recipe with `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/idempotency-FAMILY.sql`.
Use only an isolated local stack.
The shared support and cleanup files are recipe parts.
Database catalog and function-source checks verify every wrapper against the migrated database.
The guard inventory checks each client retry target against its canonical function source.

## Verification

```sh
npm run test:db:roster-lifecycle
npm run test:db:roster-oracle
npm run test:db:weekly-add-limit
npm run test:db:waiver-window
npm run test:db:dynasty-rules
npm run test:db:continuous-faab
npm run test:db:continuous-faab-schedule
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/inactive-trade-block.sql
npm run test:db:trade-roster-plans
npm run test:db:trade-plan-moves-capacity
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
Activity records offers, edits, counters, acceptance, rejection, withdrawal, veto, expiry, and completion.
Pending trade transitions remain visible only to participants.
Completed trades remain public within the league.
Events retain player identity and names when ownership later changes.
Trade-block changes stay out of the feed.
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
The server stores a completed-season base in `career_games_base` and its cutoff in `career_games_base_season`.
Below 65, the current total adds regular-season appearances after that cutoff.
An appearance has positive minutes or any positive counting statistic.
The DNP flag does not decide whether a player appeared.
The one-time ESPN lookup sums per-season GP through the previous season.
The current ESPN season and its career total do not set the base.
This avoids old gaps in our boxes and a delayed ESPN current-game update.
ESPN, rookie, and threshold bases are never fetched again.
Players with 65 or more stored games never enter the lookup queue, regardless of base source.
Their stored counts remain available; exact totals above 65 do not affect taxi eligibility.
A coverage base below 65 remains due for one successful ESPN lookup because our historical boxes have gaps.
A successful lookup replaces coverage only when the new total does not lower the stored count.
Unavailable or lower ESPN totals leave the existing count and base unchanged.
Failed lookups retry no more than weekly.
The worker attempts at most 300 players per run, with 16 concurrent jobs and a 90-second start budget.
Each player's external lookups stop after eight seconds.
Earlier sync work reduces the remaining lookup budget.
Players on an NBA team run first, followed by players closest to 65 stored career games.
Within each group, unknown counts follow known counts; the oldest attempts break ties.
Unstarted players keep their place for the next daily run.

The migration preserves every existing non-null count and leaves its base unset.
Those players keep their count until an ESPN base lookup or a fallback that does not lower the count.
For missing counts, a verified rookie gets base zero through the previous season.
That requires no observed appearance before the current season.
Otherwise, complete covered experience gets a provisional base of zero through 2020.
That coverage base stays usable while its one-time ESPN lookup is pending.
Completed covered seasons must equal `years_exp`; a current-season appearance adds one additional season.
A player with at least 65 covered appearances also gets base zero through 2020.
This last value is a lower bound that keeps taxi decisions correct.
Other missing counts remain unknown.
A late first appearance alone never proves complete career coverage.

Stats saves, corrections, deletions, game corrections, and merges recount based players within the same transaction.
Once a stored count reaches 65, later recounts cannot lower it.
Corrections below 65 still use the recounted total.
Unbased players retain their existing counts until a base succeeds.
Replays do not add games twice.
Explicit count writes, including NULL, remain valid for the deployed Edge and fixture setup.
Timestamp-only writes preserve that value.
A later stats save recounts players with a base; automatic recounts preserve known counts of at least 65.

The server stores the current total in `players.career_regular_season_games`.
The phone uses stored experience and career counts for display-only Rookie and Taxi tags.
The combined taxi badge reads `T:12` for 12 career regular-season games.
It never uses the current season game count.
Rookie means `years_exp = 0`; Taxi also requires the league to have taxi slots.
The server remains authoritative for every roster action.
An eligible rookie with an unknown count shows `T:—`; unknown never means zero.
An unknown count hides the Taxi tag for other players unless they already occupy taxi.
A taxi-held player keeps the count visible in roster rows, previews and player detail.
A known ineligible taxi player uses the warning color and an accessible “no longer eligible” label.
The badge does not override activation or roster legality rules.
Game-day injury refreshes run separately every 15 minutes.

`taxi_start_season_year` records the first taxi season. Trades and season carryover retain that value.
A missing start uses the earliest recorded taxi roster or acquisition season. Drops and later draft acquisitions do not restart that clock.
With `taxi_max_seasons = 2`, the third season promotes the player during the existing rollover.
The player stays owned. An overflowing active roster blocks restricted acquisitions and trades.
Existing lineup capacity checks still apply.
A taxi exit still prevents a return to that team's taxi.
Players must stay eligible while on taxi.
New game counts or experience can make a taxi roster illegal.

Eligible players can enter taxi through drafts, trades, or scheduled waiver claims.
Straight-to-taxi claims check eligibility, slots, tenure, and prior exits.
Accepted trades hold their incoming taxi slots until settlement.
Adds cannot use those slots, and claims fall back to active space or their planned drop.
An add cannot request both IR and taxi.
IR remains the default claim destination for eligible Out players when a slot is open.
A manager can submit a straight-to-taxi claim after the player's game starts.
The scheduled worker still decides ownership and placement.
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

## Inactive trade assets

The league's inactive-trade setting controls IR and taxi assets in offers and on the trade block.
Without that setting, IR and taxi players cannot enter new listings.
With it enabled, owned inactive players can remain listed during roster-location changes.
Losing ownership still removes a listing and expires dependent offers.
The setting never bypasses resulting-roster limits or settlement checks.

## Trade plans

All trades require legal resulting rosters before acceptance and settlement.
The inactive-trade setting controls which owned assets can be sent. It does not disable roster limits.
Each manager chooses incoming IR/taxi destinations, retained-player moves, and planned drops while the offer is pending.
Retained players can move to regular space or eligible IR. They cannot enter taxi through a roster move.
The proposer can include the plan in the existing idempotent submission payload.
Counterparties can save choices before acceptance or submit choices with acceptance.
The review and acceptance views show each team's resulting roster and capacity.
Every accepting manager confirms named drops. Acceptance submits the exact plan shown in that confirmation.
Every participant must accept before settlement.
League review settings select immediate processing, commissioner review, or member voting.
Acceptance stores and checks the plan.
Immediate processing can settle the trade within that same call.
Deferred review keeps the roster unchanged until settlement.
Settlement checks every participant again, then applies all drops, moves, transfers, and FAAB changes in one transaction.
A failed transaction restores assets, drops, placements, waiver entries, and tenure.
Vetoes, rejection, withdrawal, and expiry apply no roster changes.
Taxi assets retain taxi placement and tenure. IR assets enter the active roster unless the receiver chooses eligible IR placement.
Only Out or IR-designated incoming players can enter IR.

The active limit remains `roster_size`, which includes starters and bench players.
The total limit is `roster_size + ir_slots + taxi_slots`. IR and taxi also have separate limits.
Trades do not place incoming players into lineup slots. Existing lineup validation controls the configured starter slots.
Capacity uses the full plan, including outgoing players and chosen drops, for all participants.
Drops happen only at settlement. They use the existing release function and enter 48-hour waivers.

Pending planned drops and moves block conflicting trade assets, plans, waiver drops, and roster moves.
The reverse checks apply to plan creation. Shared team locks and sorted player locks serialize reservations.
Accepted assets, planned drops, and moves remain reserved through settlement or a terminal outcome.
Combined accepted plans reserve required regular, IR, and taxi capacity.
New awards and acceptances cannot consume that capacity. Unrelated legal roster actions remain available.
Deferred roster checks protect direct writes and permit atomic swaps. Awards also check capacity before spending FAAB.
Vetoes and terminal outcomes release these reservations without an extra balance or capacity ledger.
`test:db:trade-plan-moves-capacity` covers retained moves, recovery, authorization, combined capacity, failed awards, and release.
`test:db:trade-plan-concurrency` and `test:db:trade-waiver-concurrency` verify competing transactions.
Ownership cleanup expires dependent offers with their existing visible failure reason and notification outbox.
When a claim uses trade-plan reservations, losing its planned drop cancels the claim with an explicit reason.

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

## Timeline

Each team has one timeline from the league event log.
The timeline remains available through its route and claim history links.
Home has no timeline entry.
Each claim and trade row opens its related history.
Counteroffers and edits stay in the original offer's history.

Managers see their own failed claims, recorded reasons, and bids.
Other managers see public results without private bids, notes, or lineup assignments.
Pending trade steps stay visible to the participants.
Completed trades and score results appear for both teams.
Trade events retain the participant IDs from that action.
Direct table reads cannot access private event details.
The reader checks the caller's league membership before it projects those details.

The screen filters claims, trades, lineups, and scores.
All activity also includes real draft picks, auction awards, and settings changes.
Mock draft picks stay out of the timeline.
Settings events record changed values, including lineup slot changes.
Unchanged saves add no event.
Each row shows a relative time and the recorded reason without changes.
Trade failures retain the exact recorded completion reason.

Older activity uses a timestamp and event ID cursor.
IDs travel as strings, and the cursor preserves timestamp precision.
Equal timestamps page without gaps or duplicate rows.
The reader calls `public.view_team_timeline` through the authenticated database client.
No separate Edge route is required.
`private.timeline_event_catalog()` defines each kind and its visibility.

`tests/db/timeline-read.sql` checks access, private details, order, and cursor paging.
`tests/db/timeline-lifecycle.sql` performs claims, a counter trade, an auto-set, and score finalization.
It checks both managers' timelines and pages through the real events.
`tests/db/timeline-producers.sql` covers three-team acceptance, settings, real picks, auction awards, retries, and private trade failures.
`tests/lib/timeline/app-browser.mjs` contains the earlier Home-entry browser fixture.
That entry is removed from the current Home screen.
Use the current navigation suite for entry-point verification.
The browser smoke route list also includes Timeline.
