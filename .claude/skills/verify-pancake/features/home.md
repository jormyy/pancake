# Home matchup

Home shows the selected day’s matchup, scores, starters, and lineup controls.

## Sub-features

- `home-matchup` shows your team and the current opponent.
- `home-day` changes the displayed day and its lineup.
- `home-autoset` opens lineup options.
- `home-links` selects other matchups and opens player details.

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
- **Options.** Run `BROWSER click '[aria-label="Open auto-set lineup options"]'`. Require the `Auto-set lineup` sheet and `Edit lineup manually`. Capture it, then select `Edit lineup manually` and require the Lineup page.
- **Return path.** Use the visible back control, then select Home. Require the same teams and selected date.
- **Details.** Select another seeded matchup, require its two teams and read-only lineup, then return to your matchup. Select `Open E2E Player001 player profile` and require the matching player page.
- **Narrow view.** Run `BROWSER set viewport 375 812`, repeat day selection and the sheet, and capture both states.

## Gotchas

- The date shown above illustrates the label format. Always substitute the current snapshot’s date.
- A changed selected button alone does not prove the lineup changed. Compare displayed players with `database-before.json` for that day.
- A no-games day is valid; it must show its own state instead of stale starters from today.
- The current sheet contains manual editing. Daily automation controls live inside Lineup.
- A missing current matchup fails this journey, even if an old matchup opens.
- Home appears as the `Matchup` link in the browser accessibility tree.
