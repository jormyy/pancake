# Player screen

Player pages show statistics, projections, games, news, league history, and available roster actions.

## Sub-features

- `player-identity` preserves the selected player’s identity.
- `player-stats` changes statistics season and displays projections.
- `player-games` expands recent game statistics.
- `player-actions` offers legal claim, drop, or trade actions.
- `player-history` expands league history and news.
- `trade-player-stats` opens profiles from all trade views and restores trade state on Back.

## How to get to it (user POV)

- Open a player from Home, Roster, or Players.
- Follow the quick-view action to the full player page.
- Open a saved `/player/<id>` link.
- Tap a trade player name, photo, or row.

## Driving it with agent-browser

Preconditions:

- Require a rostered player and a free player. Populated statistics need game-stat and projection fixtures.

- **Identity.** Run `BROWSER click '[aria-label="Open E2E Player001"]'` from Roster, then choose `View E2E Player001 player page`. Require the same name, team, and position.
- **Stats.** Snapshot the season and statistics controls. Select another available season, then return. Require the matching period and values rather than a stale previous season.
- **Games and news.** Expand recent games, league history, and news from their visible controls. Require each game row’s date, opponent, and statistics.
- **Actions.** On a free player, choose Claim and require the same player in Waiver Claim. On a rostered player, inspect only the actions legal for the current manager.
- **Deep link.** Copy the observed player URL, reopen it, and require the same player page after reload.
- **Widths.** Capture statistics and actions at both widths; check the final table column and bottom action.

`trade-player-stats` opens the existing player page from trade rows, photos, and names.
Run the journey documented in [Trades](trades.md).
Require `/player/<id>`, the same player's header, and the no-stat empty state.
Back must restore selections, picks, notes, FAAB, routes, roster plan, and scroll.
Add/Remove must change selection without leaving the trade view.
The automated WebKit result does not prove physical iOS Safari or installed PWA behavior.


## Gotchas

- The extended seed includes two statistics seasons and local news for Player001 and Player052.
- Open Game log before checking recent games. Wait for the selected season’s rows before comparing values.
- A quick view is not the full player page; exercise both.
