# League rules

This doc states the league rules that managers see and the invariants the database must keep.
The database owns every rule below. The phone shows results and never decides legality.
[Architecture](architecture.md#writes-and-offline-replay) owns request IDs, receipts, and offline replay.

## Roster records and cleanup

When a player leaves a roster, linked live state changes in the same transaction:

- Trade-block listings for the player end. Pick listings end when the pick changes owner or is used.
- Future lineup rows for unstarted games clear. Rows for started or finished games stay for scoring.
- Pending trades that need the lost asset expire with a visible reason and a `trade_expired` event.
- A pending claim that planned to drop the player loses that drop, or cancels with a reason in trade-plan leagues.

`roster_transactions`, `waiver_wire_log`, succeeded `waiver_claims`, and `league_activity` are history and are never deleted.
A player merge moves history to the surviving identity and rejects unresolved ownership conflicts.
Past-season removals do not clear current live state.
`tests/db/roster-lifecycle-oracle.sql` checks these invariants after generated actions.

## History lock

Roster moves never change past dates, completed slates, or locked slots.
Only future slots with unstarted games can clear.
A saved lineup receipt keeps its row when a player changes NBA teams, so a missing box score cannot unlock it.
`private.lineup_game_started` owns the lock predicate for every path.

## Lineups and Auto Lineup

Auto Lineup fills unlocked starter slots for each enabled team.
New teams start enabled, and a manager can turn it off for the season.
The toggle rejects offline admission and never replays that intent on reconnect.
An automatic run can replace unlocked manual choices.
A run that finds nothing to change leaves rows, IDs, and timestamps untouched.

A manager can pin an active player to Start or Bench for one date.
IR and taxi players cannot take pins, and past or locked dates are read only.
A pin change runs the date optimizer at once, even with the automatic setting off.
A manual move that contradicts a pin clears that pin.
Roster removal deletes the membership's pins. IR and taxi moves delete today's and future pins.

The solver keeps locked slots, fills the most open slots, then honors Bench pins before Start pins.
It then maximizes healthy playing projections and keeps slot choices open for later games.
Out, IR, postponed, and no-game players score zero but can fill an otherwise empty slot.

The daily run becomes due at 06:00 Eastern, or ten minutes before an earlier tipoff.
Each team records one successful daily check per Eastern date.
A pre-tipoff run opens two minutes before each distinct tipoff and stays open one minute after it.
A fingerprint of rosters, injuries, games, scoring, slots, pins, and projections reopens a window when inputs change.
A game with no known tipoff opens no window until the feed supplies a time.
A locked player never moves, even if later declared Out or removed from the roster.
A player whose game starts while benched stays benched.
One member's failure records an error receipt and does not fail the other members.
The same input revision skips that failure. A new claim token fences a stale worker.
Pending trade offers do not block starter and bench changes.

## IR and Auto IR

An activation can swap an IR player with an active player when both groups are full, in one transaction.
Scheduled claims can place an eligible player straight into IR or taxi with no extra league setting.
`private.is_ir_designation` owns IR injury eligibility.

Auto Lineup also manages IR for enabled members.
Manual and automatic IR moves share one set of checks.
Auto IR fills open IR slots, swaps out healthy occupants, then trades places by return date.
The later reliable return date wins. A tie or uncertain date moves nobody and produces an `ir_choice_uncertain` notice.
Game-locked and reserved players stay put and retry on the next run.

An ineligible taxi player produces a `taxi_ineligible` notice; Auto Lineup never touches taxi.
Auto Lineup never drops a player.
A failed move group rolls back alone. A broken post-run invariant rolls back the whole call.
Notices are never stored. `public.get_auto_ir_notices` derives them from the current roster.

A league policy can turn on Auto IR for every member, including members with Auto Lineup off.
The daily run admits those members on every Eastern date, with or without a scheduled NBA game, and applies IR only; a manual member never receives a starter change.
Each tipoff window applies IR first, then reads the roster again before it picks starters.
The policy stays inert until `private.activate_league_roster_policy` sets its latches. No worker or migration sets them.
A transient IR failure (lock contention, serialization failure, statement timeout, or a fetch timeout) is retried inside the run and never writes a durable member receipt.
A policy league runs its tipoff work in its own scoped work item. A stale worker without that scope is refused with `PT409`.

## Waivers and FAAB

Every available player requires a scheduled claim. There are no instant pickups.
The server rejects instant adds and direct free-agent inserts with `PA002`.
Claims award at midnight in `leagues.timezone`, which defaults to `America/Los_Angeles`.
A claim submitted at the cutoff waits for the next run.
A dropped player completes a 48-hour hold before any run can award that player.

The highest valid FAAB bid wins. Zero-dollar bids are valid.
Equal bids use rolling team priority, then that team's claim order. A winner moves to the back.
Only a successful award spends FAAB or uses an add. Its conditional drop commits with it.
Accepted-trade FAAB reservations reduce the available balance.
Other managers never see pending bids.
The cutoff freezes edits, reorders, and cancellations while a worker is late.
Retries and overlapping workers cannot award the same player twice.
A successful award cancels other claims that need the same drop.

## Weekly roster floor

A league can opt in to a weekly minimum of active players.
The floor job runs on each week's last day, after that day's waiver run records settlement.
It needs both activation latches because it must perform the healthy IR returns before it awards.
It never runs while an NBA game is in progress and never adds a player whose game has started.
Teams with fewer than the floor active players receive adds up to exactly the floor; teams at or above it are never touched.

The pool holds unrostered, healthy players on an NBA team with a current league-scored average.
It excludes players with a wire hold, a pending claim, a trade reservation, or a started game.
The best league-scored average ranks first.
Teams take one player per pass in a weekly shuffled order until each team reaches the floor or the pool runs out.
A scoring change, a delayed average refresh after a stats correction, or an uninitialized or missing cache returns `averages_pending` and awards nobody; absent averages never mean exhaustion.
When a member's IR pass fails transiently, including a transient SQLSTATE reported in the service's `skipped` array, the floor returns `deferred` with `ir_transient` and rolls back the whole pass, so it never awards a free agent ahead of a healthy legal IR return.

A completed week is recorded and never re-opened; a failed or deferred attempt rolls back fully and retries.
A deferred week can finish late until the next week's floor run is due. Then it expires.
Floor adds spend no FAAB, priority, or weekly adds. Nothing refills between weekly runs.

## Weekly add limits

`weekly_add_limit` caps successful claims per add week.
Add weeks follow `season_weeks` in Eastern time and reset at midnight after each week ends.
After the last week, counts roll every seven days.
A commissioner override changes the count but not the reset time.

## Taxi eligibility

A player is taxi eligible with `years_exp = 0` or fewer than 65 career NBA regular-season games, whatever the draft position.
A nonrookie needs a known count to enter taxi.
An unknown count never makes an existing taxi player illegal.
Players must stay eligible while on taxi.

The career count is a completed-season base plus appearances after its cutoff.
A base below 65 gets one successful ESPN lookup of per-season games through the previous season.
ESPN, rookie, and threshold bases are never fetched again.
Players with 65 or more stored games never enter the lookup queue, regardless of base source.
A lookup or recount never lowers a stored count of 65 or more.

The roster badge reads `T:12` for 12 career regular-season games.
It never uses the current season game count.
An eligible rookie with an unknown count shows `T:—`; unknown never means zero.

`taxi_start_season_year` records the first taxi season and survives trades and rollovers.
With `taxi_max_seasons = 2`, rollover promotes the player in the third season.
A player who leaves taxi cannot return to that team's taxi.

## Legal roster gate

An ineligible IR player, an ineligible taxi player, or excess active players make a roster illegal.
The server reports `PA003` for active overflow, `PA005` for ineligible IR, and `PA009` for ineligible taxi.
An illegal roster blocks new claims, claim edits that add, sent offers, and trade acceptance.
Pending claims fail at processing while the roster stays illegal.
Lineup edits, activations, IR moves, drops, and cancellations stay available. The Roster banner offers them.

## Trades

Trades are open in the offseason, the rookie draft, the season, and playoffs.
Setup, the startup auction, and a passed commissioner deadline close trading.
New NBA rookies cannot be added or claimed before the league completes its rookie draft.

### Plans and legality

`private.check_trade_legality` owns the verdict and every suggested fix.
The composer and the acceptance preview show that same result.
All trades require legal resulting rosters before acceptance and settlement.
An outgoing IR player does not free a regular slot.

Each manager picks incoming IR or taxi destinations, retained-player moves, and drops while the offer is pending.
Only a team's own manager can save its retained moves and drops.
A retained player can move to regular space or eligible IR, never into taxi.
Only Out or IR-designated incoming players can enter IR.
Every accepting manager confirms named drops. Acceptance submits the exact plan in that confirmation.
Every participant must accept before settlement.

The active limit is `roster_size`. The total limit adds `ir_slots` and `taxi_slots`.
Capacity counts the full plan for every participant, including outgoing players and drops.
Trades never place incoming players into lineup slots.
Drops happen only at settlement and enter 48-hour waivers.

League review settings choose immediate processing, commissioner review, or member voting.
Acceptance stores the plan and moves no players, FAAB, or drops.
Settlement checks every participant again and applies every change in one transaction.
A settlement that fails legality keeps the trade accepted and marks it **Needs attention**.
A manager can repair their own plan, and the worker checks again before settlement.
The proposer can cancel an accepted trade before its review window ends.
Vetoes, rejections, withdrawals, cancellations, and expiries change no roster.

The league's inactive-trade setting decides whether IR and taxi players can be offered or listed.
The setting never bypasses resulting-roster limits or settlement checks.
The roster guard accepts a trade move only with proof from the executing transaction. A session setting alone authorizes nothing.

### Pending locks

A sent trade locks its outgoing players and picks.
A recipient's requested assets lock only when that recipient accepts.
Pending locks must read item players, planned drops, and planned moves.
A pending claim locks the claimed player and its selected drop.
A locked asset cannot leave the roster, change IR or taxi placement, or enter another trade.
Errors and the phone's lock badge name the trade or claim that holds the asset.
Accepted assets, drops, moves, and capacity stay reserved until settlement or a terminal outcome.
New awards and acceptances cannot use reserved capacity.

### Estimates and values

The trade editor asks `POST /trades/estimate` for a quote on the exact asset routes.
Estimates never bypass roster, ownership, or trade-window checks.
A quote expires after ten minutes, and a late response never replaces a newer one.
A submitted offer attaches its quote in the same transaction.
The quote must belong to the sender and match the saved routes, league, and season.
An offer sent without a quote commits first and gets its quote later from queued work.
Saved quotes never change. Revaluation with current inputs returns a separate result and saves nothing.

`core/src/dynasty/tradeScoring.ts` owns the model version, curve, and fairness tolerance.
Each player or pick contributes `1000 * (value / 1000) ** 5`, with no consolidation bonus. FAAB keeps its own rate.
A package gap of at most five percent is Fair.
Every roster location counts. A plan that overfills a section loses its lowest curved values.
Imported values get no age, health, strategy, or scoring adjustment.
A missing imported value counts as zero and appears in the missing inputs.

OneNumberHoops supplies trade values. Michael has written permission to collect and copy them.
Tests read fixtures and use fake fetches; they never request the live source.
The worker publishes at most one live sync per Eastern day and checks robots first.
A malformed or incomplete import rejects the whole snapshot and keeps the published values.
An internal CSV import accepts the same data when the live fetch fails.
Third-round picks take 40% of the matching second-round value, floored at league replacement value.
An unknown pick slot uses a stored prediction from the original owner's team strength.

Hashtag Basketball supplies ranking screens, player forecasts, and `players.dynasty_rank`.
Trade publication never writes Hashtag ranks.

## Playoffs

Explicit playoff entrants use a seeded elimination tree with `ceil(log2(entrants))` rounds.
Top seeds take byes, and each round starts after the previous round's configured weeks.
A null entrant setting keeps the legacy four- or six-team bracket.

## Draft pick years

The database stores each pick by fantasy `season_year`. Its rookie draft happens in the summer of `season_year - 1`, and labels show that year.
For season 2027, the future classes are stored as 2028 to 2030 and shown as 2027 to 2029.
Each league holds three rounds for each of three future classes.
A season advance adds one future class and keeps every existing owner.
Only those three future classes can enter trades.
Cleanup deletes a distant pick only when it is unused and has no references.

## Rookie draft order

Rookie drafts use linear order by default. Each original team keeps its slot in every round.
A traded pick goes to its current owner and keeps its original slot.
Commissioners can choose `snake` with the `rookie_draft_order` setting.
Worse records pick first. Equal records use higher points per game, then the stored seed.
Each draft saves its order choice and seed when it starts, so repeated generation gives the same order.

## Timeline privacy

Each team has one timeline from the league event log.
Managers see their own failed claims, reasons, and bids.
Other managers see public results without private bids, notes, or lineup choices.
Pending trade steps stay visible to participants only. Completed trades are public in the league.
Trade-block changes and mock draft picks stay out of the feed.
`public.view_team_timeline` checks league membership before it shows private details.
`private.timeline_event_catalog()` defines each event kind and its visibility.
