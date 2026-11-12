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
- **Multi-team partial acceptance.** Seed the offer with `node tools/verify/seed-trade-acceptance.mjs "$EVIDENCE" --full='E2E Team 3' --mode=net-plus-one --plan=drop`. Team 1 proposes, Team 2 is the middle team, Team 3 is at its roster limit. Sign in as Team 2 (`BROWSER login 2`) and accept. Require trade status `pending`, Team 2 `accepted_at` set, Team 3 `accepted_at` null, and no roster change. Sign in as Team 3 (`login 3`) and accept. Require `accepted`, then complete with `psql "$SUPABASE_DB_URL" -c 'select public.process_due_accepted_trades_atomic()'`. Require the sent player on Team 3, the planned drop gone, FAAB moved, and every team at or under its limit.
  With `--plan=none` the last acceptance must fail with `E2E Team 3: Regular roster is 1 over the limit of <n>` and must move nothing. A repeated acceptance must report that the trade is no longer pending.
  `--mode=net-neutral` sends one player back, so the full team accepts without a plan.
  Seeding writes are setup, not proof. Proof is stored state from `observe.mjs`: `trades.status`, `trade_participants.accepted_at` and `drop_player_ids`, `roster_players` counts per team, and `roster_transactions`.
- **Withdraw.** Sign in as proposer and withdraw a pending offer. Require it to leave pending views.
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


## Gotchas

- The fixtures include received offers for both managers, completed two-team and multi-team history, and a rostered player without statistics.
- Do not test acceptance by directly updating a trade’s status.
- Review ownership and destination for every asset; two columns that merely render are insufficient proof.
- Capture builder and review at both widths. The team columns must remain readable.
