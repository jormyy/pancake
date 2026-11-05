# Lineup editor

Lineup lets a manager choose starters, pin player roles, and enable daily automation.

## Sub-features

- `lineup-start` pins a bench player to Start and moves them into a legal starting slot.
- `lineup-auto` clears a pin through Auto.
- `lineup-bench` excludes a player from starters through Bench.
- `lineup-days` loads each selected date independently.
- `lineup-daily` changes the automatic daily setting.
- `lineup-slots` changes occupied and empty slots through their visible controls.

## How to get to it (user POV)

- Home → Auto-set → Edit lineup manually.
- Roster → Auto-set → Edit lineup manually.
- Open a saved `/lineup` link while signed in.

## Driving it with agent-browser

Preconditions:

- Require an active league, an unlocked bench player, and unstarted games on the selected date.
- Read `benchPlayerName` from `fixture.json`. The baseline player is `E2E Player008`.

- **Open.** Use each sheet entry point. Run `BROWSER find role button click --name 'Edit lineup manually' --exact`. Require starters, Bench, IR, taxi, and date controls.
- **Before.** Save a screenshot and database observation. Confirm Player008 is absent from today’s `weekly_lineups` starters.
- **Start.** Run `BROWSER scrollintoview '[aria-label="Pin E2E Player008 to start"]'`, then `BROWSER click '[aria-label="Pin E2E Player008 to start"]'`. Require Start to appear selected and the player to move among starters. Also inspect `aria-checked` and report it separately.
- **Stored result.** Save the screenshot and a new database observation. Require `pin=start` for that player and a non-BE slot in `weekly_lineups` on that date.
- **Persistence.** Return to Home and reopen Lineup. Require Start to remain visibly selected and the starter slot to persist.
- **Auto.** Run `BROWSER click '[aria-label="Set E2E Player008 to Auto"]'`. Require Auto visibly selected and no pin row for that date.
- **Bench.** Run `BROWSER click '[aria-label="Pin E2E Player008 to bench"]'`. Require Bench visibly selected, `pin=bench`, and no starting assignment.
- **Dates.** Select another full-date button from the snapshot. Require the other date’s own pin state. Return to today and confirm persistence.
- **Manual swap.** Pin a player to Start, select their slot, then select an eligible bench player. Require the swap and removal of the contradicted pin.
- **Other controls.** Toggle the automatic daily switch, reopen, and compare `lineup_optimizer_settings`.
- **Narrow view.** At 375×812, repeat the Start/Auto/Bench controls and confirm each remains reachable without horizontal clipping.

## Gotchas

- Started games lock players. A locked radio cannot prove a mutation; select a future unstarted date or recreate the fixture.
- Start saving triggers optimization. Wait for both pin and lineup results, not only the radio state.
- IR and taxi players do not fill ordinary starting slots.
- A failed optimization can leave a saved pin. Report both results separately.
- Optimization can move a pinned player between legal starting slots. Read the new slot label instead of assuming PG or G.
- Require exactly one checked radio for each player. Compare its visible choice, `aria-checked`, and stored pin.
