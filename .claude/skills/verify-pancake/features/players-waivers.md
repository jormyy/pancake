# Players and Waivers

Managers find players, inspect rankings and news, and submit or revise waiver claims.

## Sub-features

- `players-search` searches and filters players.
- `players-rankings` changes rankings, statistics, and season views.
- `players-news` opens player news.
- `waiver-claim` submits a claim with a FAAB bid.
- `waiver-manage` edits or cancels a pending claim.

## How to get to it (user POV)

- Select Players from the main navigation.
- Select a player’s claim action from search, a quick view, or the full player page.
- Open pending waivers from the app’s waiver view or Home waiver summary.
- Legacy `/dynasty` bookmarks lead to Players rankings.

## Driving it with agent-browser

Preconditions:

- Require an available player, sufficient FAAB, roster capacity or a legal drop, and the pending waiver fixture.

- **Search.** Select Players. Run `BROWSER fill '[aria-label="Search players"]' 'Player052'`. Require only matching rows.
- **Filters.** Run `BROWSER click '[aria-label="Show filters"]'`. Snapshot Availability, Position, Team, Health, Game today, Experience, Sort, Statistics, and Season. Change one, require filtered rows, then choose `Clear all filters`.
- **Sections.** Use the Players sections control to visit Rankings and News. Require ranked rows and news cards or an explicit empty state.
- **Claim.** Open Player052 and choose its visible Claim action. Require Waiver Claim. Run `BROWSER fill '[aria-label="FAAB bid amount"]' '2'`. Choose a legal drop if requested, then run `BROWSER click '[aria-label="Submit waiver claim"]'`.
- **Persist.** Require the pending claim in the waiver view and a matching `waiver_claims` row with bid 2. Reopen it, change the bid, and choose `Save waiver claim`.
- **Cancel.** Use the claim’s visible cancel control and confirm. Require its removal from pending claims and terminal stored status.
- **Narrow view.** Repeat filters and claim review at 375×812. Require the submit action to remain reachable.

## Gotchas

- Pending claims reserve FAAB. An available balance can differ from the total budget.
- IR and taxi destinations have separate eligibility rules.
- News needs a news fixture to prove a populated list. An empty state does not prove article navigation.
- A free-agent add and a waiver claim have different outcomes. Record which path the UI chooses.
