# Home matchup

Home shows the selected day’s matchup, scores, starters, and lineup controls.

## Sub-features

- `home-matchup` shows your team and the current opponent.
- `home-day` changes the displayed day and its lineup.
- `home-autoset` opens lineup options.
- `home-links` selects other matchups and opens player details.
- `home-positions` shows every slot, filled or empty, as a plain position label.

## How to get to it (user POV)

- Sign in and land on Home.
- Select Home from another main tab.
- Return from a matchup, player page, or lineup editor.

## Driving it with agent-browser

Preconditions:

- Sign in with `BROWSER login`. Require the current matchup fixture from `fixture.json`.

- **Initial view.** Run `BROWSER snapshot -i` and `BROWSER screenshot "$EVIDENCE/home-before-390.png"`. Require both team names and seven dated day buttons.
- **Day selection.** Read the full date label from the snapshot. Run `BROWSER click '[aria-label="Thursday, November 5"]'` with the observed date. Require that button’s `aria-current="date"` and the requested day’s lineup. Save the selected date and screenshot.
- **Return to today.** Click today’s full date label from `fixture.json`. Require today’s lineup and a single current-date button.
- **No auto-set.** Require no `Open auto-set lineup options` control on Home. Auto-set lives on Roster.
- **Details.** Select another seeded matchup, require its two teams and read-only lineup, then return to your matchup. Select `Open E2E Player001 player profile` and require the player preview sheet with season averages. Choose `View E2E Player001 player page` and require the matching player page.
- **Positions.** Save `node tools/verify/observe.mjs "$EVIDENCE"`, then tap filled and empty labels such as `[aria-label="BE slot, E2E Player009"]` and `[aria-label="Empty UTIL slot 9"]`. Require no selection outline, no dialog, no `Select ` labels, and unchanged `weekly_lineups` in a second observation. Each empty slot keeps its own `Empty <slot> slot <n>` label.
- **Narrow view.** Run `BROWSER set viewport 375 812`, repeat day selection, and capture the result.

## Gotchas

- The date shown above illustrates the label format. Always substitute the current snapshot’s date.
- A changed selected button alone does not prove the lineup changed. Compare displayed players with `database-before.json` for that day.
- A no-games day is valid; it must show its own state instead of stale starters from today.
- A missing current matchup fails this journey, even if an old matchup opens.
- Home appears as the `Matchup` link in the browser accessibility tree.
- Lineup moves live only in Lineup, reached from a Roster player's `Move <name> in lineup` action. Matchup positions never select or swap players.
