# Trades

Managers build offers, review assets, analyze trades, and manage received or sent offers.

## Sub-features

- `trade-build` builds and reviews a two-team offer.
- `trade-multi` adds participants and routes assets.
- `trade-offers` accepts, rejects, counters, or withdraws an offer.
- `trade-analyze` compares assets and projected impact.
- `trade-history` shows completed trade details.
- `trade-block` manages trade-block listings.

## How to get to it (user POV)

- Trades → Propose trade.
- Other team roster → Propose trade with this team.
- Trades → an offer card → its details or analyzer.
- Trades → History, Analyzer, or Trade block through Trade sections.

## Driving it with agent-browser

Preconditions:

- Require the pending trade fixture and two managers with tradable players and picks.
- Completed history and acceptance require a separate disposable offer that can pass roster checks.

- **Build.** Run `BROWSER click '[aria-label="Propose trade"]'`. Choose a partner, one offered asset, and one requested asset from fresh snapshots.
- **Review.** Run `BROWSER click '[aria-label="Review trade proposal"]'`. Require both team names, directions, player names, and any FAAB or picks.
- **Submit.** Select the visible submit button once. Require the new Sent offer and its stored trade/assets. Reopen to confirm terms.
- **Multi-team.** Run `BROWSER click '[aria-label="Use multi-team trade mode"]'`. Add a third participant, route assets, and require correct recipients in review before submitting.
- **Received offer.** Sign in as the generated recipient through the real form. Open the card, inspect all terms, then exercise Counter or Reject. Require a changed offer/status in the database.
- **Acceptance.** On a fresh legal offer, accept and verify terminal status plus transferred roster assets. Reload both teams before declaring success.
- **Withdraw.** Sign in as proposer and withdraw a pending offer. Require it to leave pending views.
- **Analyze and history.** Open the analyzer from a trade and from its section. Require asset identities and results. Open History and compare a completed offer’s assets and date.
- **Trade block.** Open its section, list a rostered player, reopen, and remove the listing. Verify stored listing changes.

## Gotchas

- The default fixture has a pending offer, not completed trade history.
- Do not test acceptance by directly updating a trade’s status.
- Review ownership and destination for every asset; two columns that merely render are insufficient proof.
- Capture builder and review at both widths. The team columns must remain readable.
