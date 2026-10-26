# Interface design

Pancake uses shared tokens for type, spacing, controls and player identity.
Phone Players and Block rows use 28px headshots, 13px names and 12px metadata. Other shared player rows retain 32px headshots. Compact rows reduce gaps and padding; metadata and long names wrap when needed.
Inputs keep 16px text. Buttons and interactive filters keep at least 44px touch targets.
The shell and roster section boundaries keep their existing layout.

## Headers and contextual actions

Tab headers use a 44px control row and a 1px bottom divider.
The tab text line has 14px above and below at the standard phone text size.
Transparent top borders balance the selected tab’s 2px underline.
Title headers keep their existing height.

Set Lineup and player actions use the shared `inline` button size.
Their visible surface is 28px high, with 8px horizontal label padding.
The interactive area remains at least 44px high and wide.
The label uses 12px control text with a 16px line height.
The player action slot keeps its width while data loads.

## News

News titles use the shared 13px row title with a 16px line height.
Summaries use the shared 13px body text with an 18px line height.
Rows use 8px vertical padding and 4px content gaps.
Titles and summaries wrap fully. Source names wrap without squeezing the date.
Article links, player details and feed filters retain their behavior.

## Matchup

Phone Matchup rows use 44px touch targets and shared row text sizes.
Phone names use the first initial and full surname, with suffixes retained. A 24px face sits on the right of each label, with initials as its fallback. Long names can wrap to two lines. The profile target retains the full accessible name and injury badge.
Day-to-day badges use the same red as Out. DTD, GTD and day-to-day spellings share that treatment.

The player identity opens the player profile. Only the points target opens the scoring breakdown.
The center position target still selects the lineup slot. These targets are siblings and do not overlap.
No-game rows omit NBA abbreviations and OFF text. Game rows use bold away-at-home labels, such as `TOR @ OKC`.
Live rows retain their points/rebounds/assists summary and live indicator. Scoring details remain available from points.

The weekly card keeps team names, records, scores, week and result status.
The redundant comparison bar, margin caption and “vs” text are removed.
The calendar retains date selection and day indicators. Decorative calendar, row and section divider lines are removed.
Starters use a 44px band with an inline Auto-set control. Other section bands use the shared 28px table header height.
Other matchups retain both scores and Final status. They omit redundant Live labels and internal rules.

## Player information

Roster rows, previews, trade assets and player detail share the same eligibility badge renderer.
`T:12` means taxi eligibility or taxi occupancy with 12 stored career regular-season games.
`T:—` means the count is unknown. It does not mean zero.
Known ineligible taxi occupants use a warning color and an explicit accessible label.
See [taxi rules](roster-lifecycle.md) for rookie exceptions and server authority.

Missing player fantasy-point and minute averages display as `0.0 FP · 0.0 mins` in summaries.
Tables show `0.0` under their FP and MIN columns.
These values are display defaults. They do not change stored stats, eligibility or scoring.
Other unknown statistics retain their unknown markers.

Mine in the League pick bank lists every currently owned pick, including original picks.
Each row shows draft year, round and original team. Known zero counts remain visible.

## Brand assets

[The vector mark](../assets/images/pancake-mark.svg) is the source for all app and web icons.
The original mark uses three simple pancakes, a cream butter pat and a sage plate.
Its rounded square uses muted taupe and cream, without small lettering or sports-seal detail.

| Role | Color |
|---|---|
| Background | `#E9DFD2` |
| Outline | `#87715D` |
| Plate | `#A0AB94` |
| Pancakes | `#E5CFAC`, `#F0DFC0`, `#F6EBD3` |
| Butter | `#FFFDF7` |

Run `npm run generate:brand-assets` with the project's Playwright Chromium installed.
The script exports header densities, favicon, Expo icon, boot logo, Apple touch icon and PWA icons.
Install icons use an opaque background. Header and favicon exports keep rounded transparent corners.
The central mark fits the maskable icon safe region.
The manifest launch background matches the icon background; browser chrome retains the app's theme color.

## Recent games

Every game row includes MIN beside fantasy points. Minutes use one decimal place, including zero; DNP rows retain their DNP label. Missing game minutes display an em dash; they remain distinct from a played zero-minute line. Narrow screens scroll the table horizontally so headers and minute values stay readable.

On iPhone web layouts, scrolling near the game table’s end reveals the next 15 games. The observer uses the actual vertical scroll container. It does not wait for transaction history below the table. Existing rows retain their keys and scroll position.

The game-log read supplies the season’s available regular-season games. Averages can load independently. Paging reveals cached rows and makes no extra network request. Repeated near-end events reveal one page per render. Duplicate NBA game identities appear once. Changing the player or season resets the visible page.

A failed season read shows Retry. Existing rows remain visible during recovery. Empty seasons show “No games available.” Completed logs show “All games shown.” Desktop, native and browsers without IntersectionObserver retain the manual paging control.


## Lineup

The lineup title uses the compact header variant: 16px text and a 49px row at standard text size.
Other title headers keep their existing size. Back controls retain 44px touch targets and safe-area spacing.
One Auto lineup panel sits directly below the title.
Set now offers Today, This week, and Rest of season as compact actions with 44px touch targets.
Keep updated automatically controls the saved daily preference. One-time actions leave this switch unchanged.
Panel text wraps at larger text sizes. Actions can wrap on narrow screens.
The day selector sits below the panel. The first section uses 8px top spacing.
Every empty starter, bench, IR, and taxi place remains individually visible.
Players and slots retain the manual move flow. Offline and read-only states disable lineup changes.
