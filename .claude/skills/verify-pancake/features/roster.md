# Roster

Roster shows starters, bench, injured reserve, taxi players, and each team’s player details.

## Sub-features

- `roster-groups` separates starters, bench, IR, and taxi.
- `roster-details` opens a player from a roster row.
- `roster-autoset` opens the shared lineup sheet.
- `roster-other` shows another manager’s roster.
- `roster-ir` moves an eligible player out of and back into injured reserve.
- `roster-taxi` promotes a taxi player to the active roster.
- `roster-drop` drops an unlocked player after confirmation.

## How to get to it (user POV)

- Select Roster from the main navigation.
- Select a team from Home, League standings, or a trade.
- Select a player row within either roster.

## Driving it with agent-browser

Preconditions:

- Require both populated teams and all four roster groups.

- **Your roster.** Select Roster from the current snapshot. Require the expected player names in each group and compare `roster_players` with the database observation.
- **Sheet.** Run `BROWSER click '[aria-label="Open auto-set lineup options"]'`. Require the same sheet as Home. Choose `Edit lineup manually`, then return.
- **Player.** Run `BROWSER click '[aria-label="Open E2E Player001"]'`. Snapshot the player sheet and follow `View E2E Player001 player page`. Require that player’s statistics page.
- **Other team.** From League standings select the opponent’s visible team name. Require `/team-roster?memberId=...`, that manager’s players, and no ownership controls for your own lineup.
- **IR.** Open Player015, choose Activate from IR, and confirm. Reopen the player, choose Move to IR, and confirm. Compare stored flags.
- **Taxi.** Select Activate beside Player016, read the permanent-promotion warning, and confirm. Require the player on the active roster.
- **Drop.** Open unlocked Player014, choose Drop, then confirm with the Drop button. Require removal from the roster and a stored transaction.
- **Widths.** Capture your roster and the other roster at both required widths. Scroll to IR and taxi before claiming those groups work.

## Gotchas

- Home and Roster each own a sheet entry point. Test both.
- Player quick views and full player pages are separate entry points.
- Offscreen IR or taxi rows are not proved by a screenshot of starters.
