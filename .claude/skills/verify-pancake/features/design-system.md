# Design system

Every web PWA surface uses the tokens in `constants/tokens.ts` and the shared components in `components/ui`, with Matchup and Roster as the reference look.

## Sub-features

- `design-conformance` rejects raw sizes, colors and type values outside the listed exceptions.
- `design-backdrop` paints one flat screen color behind every screen, including the cold-launch boot shell; no gradient fades in at the top.
- `design-safe-area` keeps headers below the status bar and actions above the home indicator in standalone mode.
- `design-targets` keeps every tappable control at least 44px.
- `design-journeys` keeps the four fixed journeys short: lineup pin, open current matchup, claim a free player, accept a trade.

## How to get to it (user POV)

- Open every route, tab, sheet, dialog, menu, form, toast, banner and shell piece from the screen that leads to it.
- Phone width 390 and 375 with touch, standalone with 59px top and 34px bottom insets, and desktop 1440.

## Driving it with agent-browser

Preconditions:

- Require a healthy disposable stack and the generated fixture. The trade journey accepts the seeded offer, so run it last.

- **Gate.** Run `node scripts/check-design-system.mjs`. Require the pass line.
- **Sweep.** Open every surface at every width. Require no horizontal overflow, no tappable control under 44px, no top gradient over content, and the header below the top inset in standalone.
- **Type.** Read computed font size and line height of visible text. Every pair must be a `typeScale` step.
- **Numbers.** Scores and counts are whole numbers; averages show one decimal.
- **Long names and larger text.** The fixture has no long names. In the page only, replace visible team and full player names with a 40-character name; replace Matchup's short names ("E. Player001") with "G. Feathers…", because lib/compact-player-name.ts caps them at 12 characters before render, then set root text to 200% on Roster, Matchup, Schedule and the player page. Names truncate or wrap without horizontal overflow, and scores stay in their columns. Reload before the next check.
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
- **Offline.** With the browser offline, Lineup shows "Offline · showing saved data" and disables its pins, so no write queues. The pending-action note and its Retry button are covered by tests/loading/offline-mutation-notice.test.ts.

## Every state

Drive each surface's loading, empty, error, saving and rare-data states for every role that reaches it, in all four modes, with real taps and a database readback when something saves.

- **Roles.** Users 0 and 1 are commissioner and manager. For signed out and no league, sign up fresh `example.test` accounts through the visible form; create a league with one and join it by invite code with the other, then start the draft from the League tab. Their empty screens are the new-league empty states.
- **Loading and error.** Hold or fail the screen's own request in the browser. Profile data comes from `api/views/profile`. Clear the saved screen caches in localStorage first, or the cached view hides the state. Block service workers in these contexts so requests can be routed.
- **Saving.** Hold the write until the busy state shows; the shared Button sets `aria-busy` and `aria-disabled` while loading. Release it with a refusal unless the scenario reads the saved value back.
- **Boot loading.** WebKit screenshots hang while deferred scripts are held, so photograph a scripts-off copy of the page and only check paint and ready state in the held page.
- **Update notice.** Allow service workers, keep an unsaved edit open, swap the release id in the served files, and fire `online`. Restore the served files afterwards.
- **Route error.** A malformed view body makes React throw; an aborted route file shows the reload screen. The saved screen cache keeps malformed data across Try again and reload.
- **Rare data.** Live games, week off, deadline passed, over the limit, healthy player on IR, full roster and illegal trade plans need disposable rows on the run's database. Apply one phase at a time and restore it before the next; compare the fixture fingerprint before and after.
- **Pickups.** The fixture has no players on waivers. Insert a `waiver_wire_log` row to reach "Still on waivers" from the player page, and delete it afterwards. Every web add opens the claim form, so the drop picker and its waiver confirm are not reachable.
- **Accepting a trade** with a full roster needs a roster plan, and players in a pending trade are locked.
- **History tab.** The League section strip scrolls sideways at phone width; History is past the edge until the strip is panned.
- **Inapplicable.** The native season picker is not in the web bundle; `/dynasty` and `/bracket` only redirect, so check where they land.
