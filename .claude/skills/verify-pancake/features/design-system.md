# Design system

Every web PWA surface uses the tokens in `constants/tokens.ts` and the shared components in `components/ui`, with Matchup and Roster as the reference look.

## Sub-features

- `design-inventory` lists every route, tab, sheet, dialog, menu, form, toast, banner and shell piece in `tests/ui/ui-inventory.json` with a stable ID.
- `design-conformance` rejects raw sizes, colors and type values outside the listed exceptions.
- `design-backdrop` paints one flat screen color behind every screen, including the cold-launch boot shell; no gradient fades in at the top.
- `design-safe-area` keeps headers below the status bar and actions above the home indicator in standalone mode.
- `design-targets` keeps every tappable control at least 44px.
- `design-journeys` keeps the four fixed journeys short: lineup pin, open current matchup, claim a free player, accept a trade.

## How to get to it (user POV)

- Open each inventory entry from its `entry` field.
- Phone width 390 and 375 with touch, standalone with 59px top and 34px bottom insets, and desktop 1440.

## Driving it with agent-browser

Preconditions:

- Require a healthy disposable stack and the generated fixture. The trade journey accepts the seeded offer, so run it last.

- **Gate.** Run `node scripts/check-design-system.mjs`. Require the pass line and the surface count.
- **Sweep.** For each inventory ID, open its entry at every width. Require no horizontal overflow, no tappable control under 44px, no top gradient over content, and the header below the top inset in standalone.
- **Type.** Read computed font size and line height of visible text. Every pair must be a `typeScale` step.
- **Numbers.** Scores and counts are whole numbers; averages show one decimal.
- **Long names and larger text.** The fixture has no long names. In the page only, replace visible team and player name text with a 40-character name, then set root text to 200% on Roster, Matchup, Schedule and the player page. Names truncate or wrap without horizontal overflow, and scores stay in their columns. Reload before the next check.
- **Keyboard.** Focus each input in standalone mode and require the field and its action to stay visible.
- **Journeys.** Start from `/` signed in as user 0 and count taps, including confirmations:
  - Lineup: Roster, Edit lineup and pins, the Player008 pin trigger on phones, Pin E2E Player008 to start. Require Player008 in a starter slot.
  - Matchup: League, Schedule, Open Week 6. Require the matchup with both teams.
  - Claim: Players, Open E2E Player052, Claim, Submit waiver claim. Require the Claim Submitted toast.
  - Trade: Trades, Accept trade with E2E Team 2, Accept. Require the offer under Outgoing with Withdraw acceptance.

## Gotchas

- Safe-area and standalone checks in WebKit fake `display-mode: standalone` and the insets; they do not prove a real iPhone.
- Sign in through the visible form only after the page hydrates, or the fields reset.
- Mobile WebKit does not support mouse wheel scrolling; scroll with element scrolling or touch.
- Lineup pins open a sheet below 560px, so the lineup journey has one more tap on phones than on desktop.
