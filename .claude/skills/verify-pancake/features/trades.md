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

Require these entry points in the evidence receipt:

- Propose, edit, and counter asset columns, with separate Add/Remove and unchanged pick controls.
- Multi-team selected routes and expanded deal summary, including Remove and destination controls.
- Proposal review, its roster plan, and analysis rows.
- Received offers, sent offers, and completed two-team and multi-team history cards and details.
- Analyzer selection, summary, and calculated asset rows.
- Own and another manager's trade-block listings and roster picker.
- Pending acceptance roster plan and trade entries in League activity.
- A tradeable roster player with no statistics, with its profile empty state.
- Tab order from stats to selection, Enter and Space, visible focus, and token-sized targets.

The fixture records `sentTradeId`, `receivedTradeId`, `completedTradeId`, `multiTradeId`, `pickTradeId`, and `noStatsPlayerId`.
The completed fixtures use the actual proposal, acceptance, and completion rules.
A completed pick exchange proves pick rows still open trade details.
The first manager receives a reverse offer; the second manager receives the original offer.
Fixture creation prepares state and is not interaction proof.


## Gotchas

- The fixtures include received offers for both managers, completed two-team and multi-team history, and a rostered player without statistics.
- Do not test acceptance by directly updating a trade’s status.
- Review ownership and destination for every asset; two columns that merely render are insufficient proof.
- Capture builder and review at both widths. The team columns must remain readable.
