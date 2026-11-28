# Trades

Managers build offers, review assets, analyze trades, and manage received or sent offers.

## Sub-features

- `trade-build` builds and reviews a two-team offer.
- `trade-multi` adds participants and routes assets.
- `trade-offers` accepts, rejects, counters, or withdraws an offer.
- `trade-analyze` compares assets and projected impact.
- `trade-history` shows completed trade details.
- `trade-block` manages trade-block listings.
- `trade-player-stats` opens existing profiles and keeps selection separate.
- `trade-roster-holds` warns about, undoes, and releases the roster room an accepted trade needs.
- `trade-grouping` shows Propose Trade and Review grouped by receiving team and keeps the builder steady while editing.
- `trade-picker` shows age and experience in the Add players, picks and FAAB picker, closes it on a player Add, and keeps it through a profile preview.

## How to get to it (user POV)

- Trades → Propose trade.
- Other team roster → Propose trade with this team.
- Trades → an offer card → its details or analyzer.
- Trades → History, Analyzer, or Trade block through Trade sections.
- Tap a player name, photo, or row; use the adjacent Add/Remove control to change selection.

## Driving it with agent-browser

Preconditions:

- Require the pending trade fixture and two managers with tradable players and picks.
- Require the completed two-team and multi-team fixtures for history. Use a fresh disposable offer for acceptance.

- **Build.** Run `BROWSER click '[aria-label="Propose trade"]'`. Choose a partner, one offered asset, and one requested asset from fresh snapshots.
- **Review.** Run `BROWSER click '[aria-label="Review trade proposal"]'`. Require both team names, directions, player names, and any FAAB or picks.
- **Submit.** Select the visible submit button once. Require the new Sent offer and its stored trade/assets. Reopen to confirm terms.
- **Multi-team.** Run `BROWSER click '[aria-label="Use multi-team trade mode"]'`. Add a third participant, route assets, and require correct recipients in review before submitting.
- **Received offer.** Sign in as the generated recipient through the real form. Open the card, inspect all terms, then exercise Counter or Reject. Require a changed offer/status in the database.
- **Acceptance.** On a fresh legal offer, accept and verify terminal status plus transferred roster assets. Reload both teams before declaring success.
- **Multi-team partial acceptance.** Seed the offer with `node tools/verify/seed-trade-acceptance.mjs "$EVIDENCE" --full='E2E Team 3' --mode=net-plus-one --plan=drop`. Team 1 proposes, Team 2 is the middle team, Team 3 is at its roster limit. Sign in as Team 2 (`BROWSER login 1`) and accept. Require trade status `pending`, Team 2 `accepted_at` set, Team 3 `accepted_at` null, and no roster change. Sign in as Team 3 (`BROWSER login 2`) and accept. Require `accepted`, then complete with `psql "$SUPABASE_DB_URL" -c 'select public.process_due_accepted_trades_atomic()'`. Require the sent player on Team 3, the planned drop gone, FAAB moved, and every team at or under its limit.
  With `--plan=none` the last acceptance must fail with `E2E Team 3: Regular roster is 1 over the limit of <n>` and must move nothing. A repeated acceptance must report that the trade is no longer pending.
  `--mode=net-neutral` sends one player back, so the full team accepts without a plan.
  Seeding writes are setup, not proof. Proof is stored state from `observe.mjs`: `trades.status`, `trade_participants.accepted_at` and `drop_player_ids`, `roster_players` counts per team, and `roster_transactions`.
- **Withdraw.** Sign in as proposer and withdraw a pending offer. Require it to leave pending views.
- **Undo acceptance.** Shown on the offer card and in the roster-spot warning only for a pending trade with three or more teams, after you accept and while another team has not. Two-team offers show Edit and Withdraw only, and their roster-spot warning says to withdraw the offer with no button. When Undo acceptance appears beside Edit and Withdraw, all three share one row at 320 px. The request carries the offer version; the database rechecks the rule under the trade lock and rejects a replaced offer, an old version, a two-team offer, an offer every team accepted, and a caller who has not accepted, each with 409 and no change. A successful undo clears only your `accepted_at` and keeps the offer, its items and the other acceptances. The button leaves at once after your undo, after another team edits the offer, and after the last team accepts. Seed the cards with a three-team offer you accepted, a three-team offer you proposed, a two-team sent and received offer, and an all-accepted offer, and check 390, 375 and 320.
- **Roster holds.** Seed with `node tools/verify/seed-trade-roster-holds.mjs "$EVIDENCE" --case=three-team`. The near-full team has accepted and the middle team has accepted. Sign in as the full team, open the offer, and require the roster-hold warning to name the accepted trade. Add a drop and accept; require `accepted` and the planned drop. Before the full team accepts, undo the middle team's acceptance and require its `accepted_at` cleared, the trade still pending, and the other acceptances kept. Accept again and require `accepted`. Seed `--case=overlapping` and require both offers to show the same team accepted without adding their holds; make one unanimous and require the 409 `roster_hold` conflict for the other, then have the other offer's proposer withdraw it and require the first to complete. Every blocked write path returns 409 with `code: 'roster_hold'` and the `conflicts` array.
- **Analyze and history.** Open the analyzer from a trade and from its section. Require asset identities and results. Open History and compare a completed offer’s assets and date.
- **Trade block.** Open its section, list a rostered player, reopen, and remove the listing. Verify stored listing changes.

**Trade player stats.** Complete every entry point below.
Use `node tools/verify/trade-player-stats.mjs "$EVIDENCE"` for desktop and 390×844 and 375×812 WebKit journeys.
The helper signs in through the form and uses visible controls only.
It checks each URL against the fixture player ID and compares both scroll axes.
Selections compare by identity and value; raw state files retain control order.
`controlOrderChanged` records any refresh-time reordering separately.
It saves each stats round trip and compares the prior editor controls and scroll position.
Before and after stats or selection changes, visit every sender tab and compare its routes, FAAB and draft controls. Restore the active sender before testing the target and its scroll.
Each attempt archives prior feature receipts and captures before driving. The new receipt records the attempt ID, viewports and capture files. A failed or partial attempt cannot satisfy the full-matrix checks with old captures; only all three viewports can write the canonical receipt.
Individual activity targets exclude grouped `trade-activity-*` rows; the grouped probe targets those rows explicitly.

Require these entry points in the evidence receipt:

- Propose, edit, and counter asset columns, with separate Add/Remove and unchanged pick controls.
- Scope stats targets to their asset-column selection testID; exercise Add and Remove directly in edit, counter, multi-team and analyzer builders.
- Multi-team selected routes and expanded deal summary, including Remove and destination controls.
- Remove a player through the summary, require the exact remaining assets/routes/notes/FAAB, then add them back and require the original state.
- Proposal review, its roster plan, and analysis rows.
- Received and sent offer cards and details, and completed two-team and multi-team history cards and details.
- Analyzer selection, summary, and calculated asset rows.
- Own and another manager's trade-block listings and roster picker.
- Pending acceptance roster plan, individual trade activity and grouped completed-trade player rows in League activity.
- A tradeable roster player with no statistics, with its profile empty state.
- Tab order from stats to selection, Enter and Space, visible focus, and token-sized targets.
- Equal fixed Add/Remove widths at every viewport, including a readable Remove label at 375px.
- Builder player rows in the seeded descending dynasty order, with their stats links and selection controls working together.

The fixture records `sentTradeId`, `receivedTradeId`, `completedTradeId`, `multiTradeId`, `pickTradeId`, and `noStatsPlayerId`.
The completed fixtures use the actual proposal, acceptance, and completion rules.
A completed pick exchange proves pick rows still open trade details.
The first manager receives a reverse offer; the second manager receives the original offer.
Fixture creation prepares state and is not interaction proof.
Success requires the named receipt for every documented entry point at every requested viewport.
Capture names must be unique within a viewport; column-selection evidence uses a separate namespace from stats round trips.
`tradePlayerOrder` records the three imported values and expected identities; the visible builder observation proves their order.


**Trade picker.** Open either side's Add players, picks and FAAB control at 390×844 and 375×812.
Player rows use the Roster tags: `R` for a rookie, the age, and `Yr N` from `years_exp + 1`; an unknown age or experience shows no tag, never `R` or `Yr 1`.
The seed gives no birthdates and only rookies or `years_exp=3`, so set a rookie, an unknown and a veteran on both teams in the disposable database first.
Search, scroll the picker list, open a fully visible player's profile, then return with the profile's Back and with browser Back.
Require the same side's picker with the same search text, list scroll offset, draft assets, FAAB and notes, and nothing added.
Tap Add and require the picker gone at once, the player once on that side of the proposal, and every earlier asset intact; reopen and require the picker again.
A rapid double tap on Add still adds once. Choosing a pick or editing FAAB keeps the picker open.

**Trade grouping.** Run `node tools/verify/trade-grouping.mjs "$EVIDENCE" --label=<name> --teams=2|3 --width=<w> --height=<h> [--details=1]`.
It opens its own headless WebKit touch context, signs in through the form, builds a draft through visible controls, and never sends it.
Propose Trade shows `You get` and `<team> gets` sections above Trade value; every row says `From <team>`. Review shows the same sections inside the Draft card, with Trade value directly under it and no Details toggle.
The helper compares every shown section and row with the draft stored in `sessionStorage` (`pancake:trade-composer-draft`) on both screens. The three-team draft sends two assets from different teams to you.
Add, remove and reroute run with the edited sender panel scrolled below the summary. The helper samples the panel heading on every frame the page paints (after the app's resize observer) and fails on more than 2 px of movement or any sideways scroll.
Removing from the very last panel at the bottom of the page lets the browser clamp the scroll by the removed row's height; the receipt marks it `bottomClamp` and the old build behaves the same.
`--details=1` opens Trade value details first, which used to collapse into a spinner during each update.
Each run writes `trade-grouping-<label>-<teams>team-<width>[-details]-receipt.json` and before/after screenshots and snapshots for every step.

## Gotchas

- The fixtures include received offers for both managers, completed two-team and multi-team history, and a rostered player without statistics.
- Do not test acceptance by directly updating a trade’s status.
- Review ownership and destination for every asset; two columns that merely render are insufficient proof.
- Capture builder and review at both widths. The team columns must remain readable.
- The routing sheet names your own team by team name, while the grouped sections call it `You`.
- After a player Add closes the picker, the web page ignores taps for 350 ms so a double tap cannot reach the proposal; wait before the next tap.
- Tap only a fully visible picker row; the browser scrolls a half-hidden row into view first, which changes the offset you compare.
