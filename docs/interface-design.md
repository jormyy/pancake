# Interface design

Pancake is a phone-first PWA.
`constants/tokens.ts` owns every measurement, color, type size, and motion value.
`components/ui/` owns the shared layouts and controls, such as `PlayerRow`, `PageHeader`, `Sheet`, and `Badge`.
Screens pass content, labels, and actions to these components.

## Rules

- Use semantic tokens such as `colors.primary`, not raw palette values, in screens.
- Change a token or component token before you add a screen-specific measurement.
- Keep every touch target at least 44px.
- Keep input text at 16px so iOS does not zoom.
- Let rows and badges grow with enlarged text; do not fix their heights.
- Wrap or shrink player names; do not truncate them with an ellipsis.
- Show league dates and tipoff times in the league timezone; keep NBA game dates for scoring.
- In trade review, the status card never shows another team or its roster.
- Acceptance always opens the trade review screen, including for rosters that are already valid.
- Keep screenshots and capture reports outside tracked source.

`npm run check:design-system` rejects raw visual values in screens and feature components.
`npm run check:quality` runs it.
`tests/ui/design-system.test.ts` checks token propagation and control sizes.
Its negative control restores fixed header heights and must fail.

## Navigation

Home is the current matchup: teams, scores, forecast, day selector, and both lineups in one scroller.
Players groups Players, Waivers, Rankings, and News.
League groups Standings, Activity, Picks, Schedule, Draft, Bracket, and Settings.
Trades groups Offers, Block, History, and Analyzer.
The menu opens league settings, commissioner tools, invites, notifications, and profile.

## Phone checks

Capture screens at 360px and 390px wide, with text scale 1 and 1.3.
Use `tests/ui/release-design-capture.mjs` against an isolated local fixture.
It checks targets, clipped text, overlap, overflow, and header geometry.
Browser emulation does not prove physical iPhone behavior.
Check a real iPhone before a release that changes layout.

## Brand assets

`assets/images/pancake-mark.svg` is the source for app and web icons.
Run `npm run generate:brand-assets` to export every icon size.
Install icons use opaque backgrounds; header and favicon exports keep transparent corners.
Keep the mark inside the maskable safe region.
