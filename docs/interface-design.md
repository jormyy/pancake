# Interface design reference

`constants/tokens.ts` owns measurements and colors.
`components/ui/` owns shared layouts and controls.
Screens pass content, labels, and actions to these components.

## Foundation tokens

| Export | Purpose | Defaults |
| --- | --- | --- |
| `foundation` | Grid and minimum target | 4px grid, 2px half grid, 44px target |
| `spacing` | Gaps and padding | `xxs` 2, `xs` 4, `sm` 6, `md` 8, `lg` 12, `xl` 16px |
| `spacing` | Larger gaps | `2xl` 20, `3xl` 20, `4xl` 24, `5xl` 32, `6xl` 40px |
| `radii` | Corners | `xs` 4, `sm` 6, `md` 8, `lg` 10, `xl` 12, `2xl` 16, `3xl` 20px |
| `radii.full` | Pills and circles | 9999px |
| `borderWidth` | Rules and outlines | `thin` 1, `medium` 1.5, `strong` 2, `accent` 3px |
| `fontSize` | Small type | `2xs` 10, `xs` 11, `2sm` 12, `sm` 12, `md` 13, `2md` 14px |
| `fontSize` | Large type | `lg` 16, `2lg` 17, `xl` 18, `2xl` 20, `3xl` 24, `4xl` 28, `5xl` 32px |
| `fontFamily` | Outfit faces | Display bold, display semibold, control medium |
| `fontWeight` | Weight scale | 300, 400, 500, 600, 700, 800, 900 |
| `controlSize` | Controls, icons, avatars | 44px minimum target; 16px input text |
| `table` | Data rows and columns | 28px header, 48px standard row, 44px compact row, 44px stat column |
| `layout` | Content and shell geometry | 1280px content, 720px form, 680px lineup, 1120px stat lineup |
| `breakpoints` | Layout changes | Phone 560, roster 760, compact 780, auth 860, stats 920, desktop 1000, wide 1200px |
| `motion` | Feedback | 80, 140, 220, 320ms; pressed opacity 0.76 |
| `elevation` | Platform shadows | None, small, medium, large, extra large, navigation, brand |

## Text roles

| Role in `textStyles` | Size / line height | Use |
| --- | --- | --- |
| `hero` | 32 / 36px | Main score |
| `compactScore` | 24 / 28px | Compact score |
| `pageTitle` | 18 / 24px | Standard page title |
| `rowTitle` | 13 / 16px | Player names and news titles |
| `body` | 13 / 18px | Summaries and descriptions |
| `meta` | 12 / 14px | Player metadata |
| `sectionLabel` | 11 / 14px | Section names |
| `tableHeader` | 10 / 12px | Column names |
| `stat` | 12px | Tabular statistics |
| `tableCell` | 12px | Table values |

## Color tokens

Use semantic colors rather than raw palette values in screens.
Web colors follow the chosen light, dark, or system theme.

| Export | Use |
| --- | --- |
| `palette` | Raw colors for token definitions |
| `colors` | Text, surfaces, borders, primary actions, danger, success, warning, information |
| `brand` | Dark brand surfaces and their text |
| `uiColors` | Domain surfaces, labels, and status borders |
| `positionColors` | Position identity |
| `INJURY_COLORS` | Injury badges |
| `TX_COLORS` | Transaction types |
| `TRADE_STATUS_COLORS` | Trade status backgrounds and text |
| `scrim` | Shared sheet backdrop |
| `alpha` | Theme-aware transparent colors |
| `themeVariablesCss` | Light and dark web variables |

The light theme uses parchment surfaces and maple actions.
Its primary text is `#1F2421`; its primary action color is `#A65317`.
The screen background is `#F7F1E8`; the card background is `#FFFDF7`.

## Component tokens

`componentTokens` combines foundation tokens into named layouts.
Change these definitions before adding screen-specific measurements.

| Token group | Defaults |
| --- | --- |
| `playerRow.compact` | 28px avatar, 44px row minimum, 8px identity gap, no copy gap, 4px vertical padding |
| `playerRow.standard` | 32px avatar, 48px row minimum, 8px identity gap, 2px copy gap, 6px vertical padding |
| `playerRow.name` | 13px name with 16px line height |
| `playerRow.metadata` | 12px metadata with 14px line height |
| `playerRow.actionWidth` | 44px reserved action column |
| `playerRow.lineupHeight` | 52px lineup row minimum |
| `pageHeader.standard` | 56px minimum, 4px vertical padding, 18px title |
| `pageHeader.compact` | 49px minimum, 2px vertical padding, 16px title with 20px line height |
| `pageHeader.tabs` | 45px row including its 1px divider |
| `listHeader` | 28px noninteractive row; interactive headers use 44px targets |
| `sectionBand` | 28px band, 12px horizontal padding, 4px vertical padding |
| `sectionBand.actionHeight` | 44px for bands with controls |
| `badge.standard` | 8px horizontal padding, 3px vertical padding, 6px corners |
| `badge.inline` | 16px minimum height, 2px horizontal padding |
| `badge.position` | 16px minimum height, 10px label with 14px line height |
| `badge.count` | 18px minimum height and width, circular corners |
| `badge.status` | 8px horizontal padding, 2px vertical padding, pill corners |
| `badge.small` | 6px horizontal padding, 2px vertical padding, 10px label |
| `badge.outlined` | 8px horizontal padding, 4px vertical padding, 1px border; compact padding is 2px |
| `badge.ownership` | 16px minimum height; 90px table width; at most 96px on phones |
| `statCell` | 44px column; 12px tabular text aligned right; 17px centered summary values |
| `matchupRow` | 52px slot, 64px points, 34px stat columns, 46px wide stat columns, 24px phone avatar |
| `segmentedControl` | 44px minimum target, 12px horizontal padding, selected background highlight |
| `textLink` | 44px minimum target and 20px line height |
| `lineupControls` | 44px targets; 13px labels; season action receives 1.4 times the width |
| `daySelector.compact` | 2px gaps above, below, and between date targets |
| `sheet` | 560px maximum width, 52px header, 16px content padding |
| `sheet` | Phone height at most 88%; desktop height at most 86% |
| `sheet` | 20px phone corners; 16px desktop corners |

Minimum heights allow enlarged text to increase the layout height.
Standard player names and metadata wrap instead of hiding information.
Compact fantasy names follow the fitted-name rule below.
Inline badges grow when text needs more height.

## Shared components

Import shared components from `components/ui` or their direct files.

| Component | Inputs | Contract |
| --- | --- | --- |
| `PlayerRow` | Name, avatar, team, positions, eligibility, metadata, stats, `variant` or `compact` | Shared identity layout with compact and standard variants |
| `PageHeader` | Title, metadata, tabs, actions, back action, `variant` | Standard or compact title header; tabs retain their own row |
| `ListHeader` | Children, `interactive`, style, native view props | Aligns data columns; interactive headers reserve 44px |
| `SectionBand` | Label, detail, tone, variant | Standard, matchup, action, and plain section layouts |
| `Badge` | Label, accessible label, color, text color, variant, size | Solid or soft fill; standard, inline, count, status, ownership, small, and outlined sizes |
| `Sheet` | Visibility, title, accessible label, close action, children | Bottom sheet on phones; centered dialog on wider screens |
| `SegmentedControl` | Options, value, change action, labels, variant | Pills or tabs; preserves arrow-key focus and selected state |
| `StatCell` | Value, integer mode, highlight, table or summary variant, native text props | Shared numeric formatting, width, and highlight |
| `LineupControls` | Actions, automatic state, disabled states, change action | One-time actions and one accessible automatic switch |
| `Button` | Label, variant, size, action, accessible props | Inline surface is 28px; its target remains at least 44px |
| `Input` | Native input props, label, error, hint, icon | Keeps 16px input text and an accessible label |
| `Page` | Title, width, padding, children | Screen background, content width, and accessible page heading |
| `ModalScreen` | Title, back action, actions, children | Uses the standard page header |

The `compact` boolean remains supported on `PageHeader`.
An explicit `variant` takes precedence.
The lineup uses the compact variant throughout loading and loaded states.
The base header height also sets the compact height, with a 7px difference.
`tests/ui/design-system.test.ts` changes that one token and measures both variants.
Its negative control restores fixed heights and must fail.

`components/player/PlayerRowContent.tsx` remains a compatibility export for `PlayerRow`.
`components/Badge.tsx` keeps the injury renderer and exports the shared badge.
These exports give existing screens the shared implementation without changing their data reads.

## Screen adoption

| Screen or surface | Shared styles and components |
| --- | --- |
| Home / Matchup | Section bands use `SectionBand`; score status uses `Badge`; row widths and avatars use matchup tokens |
| Players | `PageHeader`, `ListHeader`, `PlayerRow`, `StatCell`, shared search field tokens |
| Rankings and News | Existing page header, shared player identity, type, spacing, and controls |
| Roster | `PageHeader`, `ListHeader`, `StatCell`, `RosterSectionBand` through `SectionBand`, shared player identity, 44px pending-claims jump target |
| Trades / Block | Existing `PageHeader`; shared player identity, badges, section headings, and row padding |
| League standings | `ListHeader` and shared You badge; sort labels and selected state remain unchanged |
| League pick bank | `ListHeader`; player and owner columns retain their content |
| League activity, results, drafts, and settings | Existing page header, shared room status badges, identity, type, spacing, and controls |
| Profile | Existing `PageHeader`, shared inputs, buttons, tabs, and sheets |
| Lineup | Compact `PageHeader`, `LineupControls`, `SectionBand`, date spacing, shared player identity |
| Player detail | Shared identity badges; recent games use `ListHeader` |
| Team roster | Existing `PageHeader`, shared roster bands, player identity, and badges |
| Claim player | Existing `PageHeader`, shared player identity and controls |
| Propose trade | Existing `PageHeader`, shared player identity, badges, controls, and sheets |
| Auction and rookie draft rooms | Existing draft page header, shared rookie column header, player identity, and badges |
| Bracket | Existing `ModalScreen`; shared matchup status badge |
| Commissioner, create league, join league, password, notifications | Existing `ModalScreen` uses the shared page header |
| Sign in and sign up | Existing shared inputs, buttons, palette, type, and spacing |
| Missing page and draft fallback | Existing shared page header and controls |
| Auto-set, player, roster, and trade sheets | Shared sheet geometry, title, content padding, and close target |

## Navigation

Home is the matchup screen.
It shows week status, teams, records, scores, forecasts, days, and both lineups.
The header, day selector, and rows share one vertical scroller.
Other matchups open a detail page with their own selected date.
Their bottom matchup strip keeps team browsing separate from the Home action.
Home restores its cached matchup when the user returns.
Home has no timeline, waivers card, announcement card, or separate daily editor.

Players groups Players, Waivers, Rankings, and News.
League opens Standings by default.
Its section bar contains Standings, Activity, Picks, Draft, Bracket, and Settings.
Trades contains Offers, Block, History, and Analyzer in that order.
Section bars use a background highlight without an underline.
Players and Trades restore their last selected section before reading data.
The hamburger menu opens league settings, commissioner tools, invites, notifications, and profile.
The screen does not repeat the shell's league name.

Web modal pages omit visible title and back rows.
Native pages can show a close control.
Navigation targets stay at least 44px.
The shell preserves safe-area spacing and expands for wrapped league names.
[The feature map](supabase-backend-route-inventory.md#navigation-feature-map) records current entry points.

## League dates and times

Home, Roster, player availability, and shared screen context use the league timezone.
Day labels and displayed tipoff times follow that timezone and include its short name.
Waivers show the next league-local midnight, including daylight saving changes.
NBA statistics and scoring retain NBA game dates.

## Player profiles

The overview loads first with identity, injuries, full-season averages, projection, ownership, and claim actions.
Games, news, and history load as separate sections when opened.
Matchup rows receive game lines and tipoff times together on their first render.
Rankings and profiles show the stored dynasty value when available.
Both compact and legacy profile responses keep that value.

## Player rows and names

Shared player rows align the headshot, name, team, positions, badges, and statistics.
Compact fantasy names use the last word before a suffix as the surname.
Remove Jr., Sr., II, III, IV, and V before applying the rule.
Use first initial and surname when the result has at most 12 characters.
Otherwise show the complete surname.
Long surnames and one-word names shrink onto one line without ellipsis.
Accessible profile labels retain the full name.

Matchup rows have two lines inside a 56px player block.
The first line contains the name and injury status.
The second contains the game or final-game statistics.
No-game players retain an empty second line.
Fantasy points stay vertically centered.
Headshots sit beside the center position column.
Mirrored names and badges extend outward.
Only the points target opens the scoring breakdown.
The profile and slot controls stay separate.
Game rows retain the away-at-home label and tipoff or live state.
No-game rows omit team abbreviations and OFF text.

Age appears directly before the experience badge.
Rookie and taxi badges use stored server values.
Taxi badges appear only when the league has taxi slots.
`T:12` means 12 stored career regular-season games.
`T:—` means an unknown count for an existing taxi occupant.
Known ineligible occupants retain a warning and explicit accessible label.
DTD, GTD, and day-to-day injuries use the same red as Out.
Badges grow with text and retain readable labels.

Missing fantasy-point and minute averages display `0.0 FP · 0.0 mins`.
Other unknown statistics retain their unknown markers.
These display defaults do not change stored scores.
Provider names and update captions stay out of compact player, ranking, projection, and news rows.
Player projections use one opponent, time, and points line.
Trade assets show a name, team and positions, then their value.
Value ranges fit on one line.
Trade block entries have a border and space between entries.
Row dividers use the shared separator color.

## Matchup forecasts

Forecast lines place projections outside the win percentages.
One flexible bar sits between the percentages with `spacing.xs` gaps.
The bar splits at the left win probability.
The winning portion uses `colors.success`; the losing portion uses `colors.danger`.
Ties split green and red equally.
Labels use tabular numerals and the minimum `textStyles.meta` size without wrapping.
The current matchup card uses `colors.primary` and `borderWidth.strong`.
Other cards use the default border.
Forecast lines show rounded final points and supplied win odds.
Final points include earned points and projected remaining games.
Absent provider values use the mean of at least five recent completed games.
Started games retain their saved pregame estimate.
Missing final points show “n/a proj”.
Saved odds remain visible when a projected total is missing.
If saved odds are missing, the display uses each team's share of projected finals.
Missing finals fall back to current points for that display calculation.
Negative totals count as zero; ties show 50%.
An absent forecast shows “pending”; a failed read shows “n/a”.
This display fallback does not change the stored forecast model or its coverage.

## Lineup and waivers

The lineup page uses the shared compact header.
Today, This week, and Rest of season form its first control row.
Keep updated automatically and one switch form its second row.
One-time actions leave that saved preference unchanged.
Both rows preserve 44px targets.
The day strip follows the switch with 2px spacing above and below.
Every empty starter, bench, IR, and taxi place remains visible.
Offline and read-only states disable lineup moves.

Home and Roster retain Auto-set with the label Open auto-set lineup options.
Their sheets include Edit lineup manually.
The claims pill reads `0 Waivers`, `1 Waiver`, or the plural count.
Zero opens Players; a positive count opens Waivers.
Waivers shows budget, priority, next run, and pickup count above pending claims.
Use `Pickups 0/2 this week` for that count format.
Keep bid rules and dropped-player hold rules out of this summary.
Keep actionable errors and offline messages.

## Trades

The review step shows the resulting roster before submission or acceptance.
It names the next legal action and the exact player count.
Where possible, it offers an eligible IR move or a move to Regular.
Otherwise it requires the needed drops.
The direct choices use Regular, IR, and Taxi.
A legal preview reads Roster ready.
A failed preview cannot enable acceptance.
Named drops require confirmation.
The server validates the same submitted plan.

History cards show status, veto deadline, and one row per asset.
Values show sent then received, such as `1412 vs 605`.
Cards prefer current source values, then saved asset values or saved totals.
Cards omit a missing comparison.
Cards omit timeline links, saved dates, and source captions.
Analyzer requests current estimates and revaluations.
Revaluation preserves the original quote.
Its compact rows omit an extra title row and explanatory captions.

## Recent games

Every game row includes MIN beside fantasy points.
Minutes use one decimal place, including zero.
DNP and missing minutes stay distinct from a played zero-minute line.
Narrow tables scroll horizontally.
Near-end scrolling reveals the next 15 cached games without another request.
Player and season changes reset the visible page.
Retry, empty, complete, and manual paging states remain available.

## Verification

`npm run check:design-system` checks screens and feature components for raw visual values.
Shared tokens and primitives own colors, type, radii, and spacing.
The quality check includes this rule.
`tests/ui/design-system.test.ts` checks token propagation and accessible control sizes.
Its negative control restores fixed header heights and must fail.

Run browser captures at 360px and 390px with text scales 1 and 1.3.
Use `tests/ui/release-design-capture.mjs` with an isolated local fixture.
It checks targets, clipped text, overlap, overflow, and compact header geometry.
`tests/e2e/ux-round3.mjs` and `tests/e2e/ui-round4.mjs` cover later matchup and trade changes.
Keep screenshots and reports outside tracked source.
Component captures do not prove every release screen fits.
Browser emulation does not prove physical iPhone behavior.

## Brand assets

[The vector mark](../assets/images/pancake-mark.svg) owns app and web icons.
It uses three pancakes, a cream butter pat, and a sage plate.

| Role | Color |
| --- | --- |
| Background | `#E9DFD2` |
| Outline | `#87715D` |
| Plate | `#A0AB94` |
| Pancakes | `#E5CFAC`, `#F0DFC0`, `#F6EBD3` |
| Butter | `#FFFDF7` |

`npm run generate:brand-assets` exports the supported icon sizes.
Use the project's Playwright Chromium installation.
Install icons use opaque backgrounds.
Header and favicon exports retain transparent corners.
The mark stays inside the maskable safe region.
The launch background matches the icon background.
