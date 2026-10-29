# Trade legality

The database owns the verdict and every suggested fix.
The composer and acceptance preview show the same SQL result.
An invalid submission keeps the selected assets and roster choices.

## Saved terms

`trade_participants.drop_player_ids` lists drops at execution.
`trade_participants.roster_moves` lists retained players and their destination.
Destinations are `active`, `ir`, and `taxi`.
Each `trade_items` player uses `to_ir` or `to_taxi`.
Both flags are false for a Regular destination.
The sender can choose incoming destinations for either team.
Only a team's manager can save its retained-player moves and drops.

The pending-lock lane must read the item players, planned drops, and planned moves.
The executor sets `pancake.applied_trade_id` while it applies the saved terms.
The roster guard checks that ID against a private player proof from the same transaction.
It also checks the saved route and destination.
A setting alone cannot authorize a roster change.
The executor restores the prior setting before it returns.
This change does not add pending locks.

## Check and execution

`private.check_trade_legality` returns each team's resulting roster, limits, reasons, and possible fixes.
Reasons identify the team, rule, affected player or count, message, and suggested moves.
The public preview checks league membership before it calls the shared check.
The submit and accept functions check the saved terms before they commit.

Acceptance saves the recipient's choices and starts the configured review window.
It does not move players, spend FAAB, or apply drops.
Execution locks the relevant players and checks current eligibility again.
It applies the trade and both managers' saved choices in one transaction.

An invalid execution keeps `status = accepted` and stores `legality_issues`.
The interface calls this state “Needs attention.”
The database queues one notice for each participant and distinct reason set.
A manager can repair their own plan while the trade needs attention.
The worker checks again before it executes the repaired trade.

## Reported IR case

The copied roster has 20 Regular players and Jimmy Butler III on IR.
Trading Butler for a Regular player leaves Justin with 21 Regular players.
The check explains that an outgoing IR player does not free a Regular slot.
It offers a drop or an eligible IR move by player name.
The audit preserves the copied limits and confirms that a selected drop fixes the sender.

## Verification

Run `tests/db/trade-structured-legality.sql` against the private database.
Run `tests/db/trade-production-shaped.mjs` with `TRADE_BACKUP_PATH` and the private `SUPABASE_DB_URL`.
The audit imports only player, roster, league, season, and member rows into temporary tables.
It rolls back every fixture change.

Run `tests/e2e/trade-legality-browser.mjs` for the WebKit flow.
Set `E2E_BROWSER_ARTIFACT_DIR` to an external evidence folder.
The test uses a 390-pixel phone viewport and a separate browser.
It checks invalid submission, both saved plans, review delay, held execution, and the final rosters.

## Cancellation during review

The proposer can cancel an accepted trade before its review window ends.
SQL locks the trade and checks the proposer, user, status, and review deadline.
Cancellation changes the status to `withdrawn`.
Neither roster plan executes.
The existing reservation queries release its players, picks, planned moves, drops, and FAAB.
The trade cannot execute after cancellation.
