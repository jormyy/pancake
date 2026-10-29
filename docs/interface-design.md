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
| `lineupControls` | 44px targets; automatic preference row |
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
| `LineupControls` | Automatic state, disabled state, change action | One accessible automatic switch |
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
Header arrows wrap through the same matchups as the bottom strip, with the viewer first and the selected day preserved.
Home restores its cached matchup when the user returns.
Home has no timeline, waivers card, announcement card, or separate daily editor.

Players groups Players, Waivers, Rankings, and News.
League opens Standings by default.
Its section bar contains Standings, Activity, Picks, Schedule, Draft, Bracket, and Settings.
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
Daily Total separates starters from bench and sums the selected day's starter scores in compact score type.
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
Keep updated automatically and one switch form its control row.
The row preserves a 44px target.
The day strip follows the switch with 2px spacing above and below.
Every empty starter, bench, IR, and taxi place remains visible.
Offline and read-only states disable lineup moves.
Manual changes apply only to the selected day.
The editor and roster Auto-set sheet have no period choices.

Home and Roster retain Auto-set with the label Open auto-set lineup options.
Their sheets offer only Edit lineup manually.
The claims pill reads `0 Waivers`, `1 Waiver`, or the plural count.
Zero opens Players; a positive count opens Waivers.
Waivers shows budget, priority, next run, and pickup count above pending claims.
Use `Pickups 0/2 this week` for that count format.
Keep bid rules and dropped-player hold rules out of this summary.
Keep actionable errors and offline messages.

## Trades

Propose and accept use one review screen.
The header places Close on the left and Send or Accept on the right.
The Trades list card appears first, with its assets and expiry.
Proposal review labels this card Draft.
A compact status card follows it.
Valid roster uses the success color; Invalid roster uses the danger color.
Each structured rule failure occupies one line.
Only the viewer's roster appears, grouped into Regular, IR, and Taxi.
Incoming players carry an Incoming label.
Each player uses the shared Roster row and available season averages.
The name keeps its full row width; move controls occupy a separate line.
Ineligible Regular, IR, Taxi, and Drop choices stay disabled.
Planned drops stay visible so the viewer can undo them.
Each move requests a new legality result.
Send and Accept require a valid viewer roster and current validation.
The status card never shows another team or its roster.
Acceptance always opens this screen, including already-valid rosters.
The saved plan still travels with the existing submission and acceptance calls.
RPC parameters and saved plan fields stay unchanged.

Every trade pick names its draft year, round, and original team.
Receive and give sections omit the repeated sender and recipient.
Standalone activity and summary labels keep both names.
Only the viewing member becomes You.
Original team names stay explicit, including the viewer's original picks.
Submitted summaries, pending offers, review, history, and activity use one pick label.
Standalone history labels keep the trade's original sender and recipient.
Pick labels wrap without truncation on phones.

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

## League schedule

Schedule uses the shared section tabs and table tokens.
Rows show the week, opponent, and result or live score.
The current week uses the shared highlight and a Current label.
Undecided playoff weeks show Playoffs without an opponent.
Week boundaries use the league calendar and timezone.

## Trade review reference

### Reused components

| Component | Use |
| --- | --- |
| `TradeCard` | The Trades list layout, assets, expiry, and Draft badge. |
| `StatusChip`, `PendingMutationBadge` | Existing card status and pending state. |
| `AssetList`, `TradeItemLine`, `TradePickLabel` | The existing player and pick lines inside the card. |
| `TradeRosterPlanEditor`, `PendingTradeRosterPlan` | Existing saved choices and acceptance container. |
| `RosterPlayerRow` | The row extracted from `RosterPlayerItem`, with unchanged Roster page actions. |
| `RosterSectionBand`, `SectionBand` | Regular, IR, Taxi, and planned-drop headings. |
| `PlayerRowContent`, `PlayerStats` | The existing roster identity and FP/minutes display. |
| `PlayerAvatar`, `Avatar`, `PosTag`, `PlayerEligibilityTags`, `Badge` | Existing player assets and metadata within those rows. |
| `PageHeader`, `BackButton`, `ErrorBanner`, `SafeAreaView` | Existing header, close control, errors, and safe area. |

### Changed files

| File | Change |
| --- | --- |
| [app/(modals)/propose-trade.tsx](../app/(modals)/propose-trade.tsx) | Uses shared review and checks only the proposer roster. |
| [components/roster/RosterItems.tsx](../components/roster/RosterItems.tsx) | Extracts the reusable row without changing Roster actions. |
| [components/trades/PendingTradeRosterPlan.tsx](../components/trades/PendingTradeRosterPlan.tsx) | Uses shared review for acceptance and saved moves. |
| [components/trades/TradeCard.tsx](../components/trades/TradeCard.tsx) | Adds the review variant and Draft state. |
| [components/trades/TradeLegalityScreen.tsx](../components/trades/TradeLegalityScreen.tsx) | Owns the shared review layout and status card. |
| [components/trades/TradeListRow.tsx](../components/trades/TradeListRow.tsx) | Opens review directly from incoming Accept. |
| [components/trades/TradeRosterPlanEditor.tsx](../components/trades/TradeRosterPlanEditor.tsx) | Separates player identity from move controls. |
| `components/trades/TradeRosterPreviewList.tsx` | Deletes the verbose roster summary. |
| [components/trades/acceptance-summary.ts](../components/trades/acceptance-summary.ts) | Removes an unused export. |
| [docs/interface-design.md](../docs/interface-design.md) | Records the design, files, reuse, and verification. |
| [lib/trade-draft.ts](../lib/trade-draft.ts) | Builds the draft card data from selected assets. |
| [lib/trade-legality-step.ts](../lib/trade-legality-step.ts) | Retains the SQL verdict helper. |
| [lib/trade-roster-status.ts](../lib/trade-roster-status.ts) | Formats short structured rule reasons. |
| [tests/app/propose-trade-ownership.test.ts](../tests/app/propose-trade-ownership.test.ts) | Updates focused component and regression coverage. |
| [tests/components/trades/offer-refresh.test.ts](../tests/components/trades/offer-refresh.test.ts) | Updates focused component and regression coverage. |
| [tests/components/trades/review-details.test.ts](../tests/components/trades/review-details.test.ts) | Updates focused component and regression coverage. |
| [tests/db/trade-production-shaped.mjs](../tests/db/trade-production-shaped.mjs) | Allows an explicit private audit port. |
| [tests/e2e/trade-legal-redesign.mjs](../tests/e2e/trade-legal-redesign.mjs) | Checks phone layouts, both flows, themes, and saved plans. |
| [tests/e2e/trade-legal-server.mjs](../tests/e2e/trade-legal-server.mjs) | Serves the isolated browser build. |
| [tests/e2e/trade-legality-browser.mjs](../tests/e2e/trade-legality-browser.mjs) | Selects the redesign verification recipe. |
| [tests/trade-accept-legality.test.ts](../tests/trade-accept-legality.test.ts) | Updates focused component and regression coverage. |
| [tests/trade-avatar.test.ts](../tests/trade-avatar.test.ts) | Updates focused component and regression coverage. |
| [tests/trade-block-stats.test.ts](../tests/trade-block-stats.test.ts) | Updates focused component and regression coverage. |
| [tests/trade-card-analyze.test.ts](../tests/trade-card-analyze.test.ts) | Updates focused component and regression coverage. |
| [tests/trade-legality-step.test.ts](../tests/trade-legality-step.test.ts) | Updates focused component and regression coverage. |
| [tests/trade-roster-plan.test.ts](../tests/trade-roster-plan.test.ts) | Updates focused component and regression coverage. |

### Verification commands

Run these with Node 22:

```sh
npx vitest run tests/trade-*.test.ts tests/hooks/trade-*.test.ts tests/lib/trade-*.test.ts tests/components/trades tests/app/propose-trade-ownership.test.ts
npm run lint:all
npm run typecheck && npm run typecheck:tests
npm run check:quality
```

Run these only against the private stack:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-structured-legality.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-incoming-destinations.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-plan-moves-capacity.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/release2-trade-accept-capacity.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/server-trade-plan-acceptance.sql
E2E_TRADE_LEGAL_REDESIGN=1 E2E_AGENT_BROWSER=1 E2E_BROWSER_ARTIFACT_DIR=../evidence/after node tests/e2e/trade-legality-browser.mjs
```

Export the browser build with `expo export --platform web --clear` and the private stack environment.
The cleared cache prevents an earlier local endpoint from entering the build.
The browser recipe permits only its two exact local origins.
The recipe starts and stops its own static server.
Use `E2E_TRADE_WEB_DIR` to select the exported directory.
Use `E2E_EXPECT_LEGACY=1` with the old export to exercise the failing width guard.

The focused suite passes 381 checks, with three existing checks skipped.
The shared row and review subset passes 95 checks.
The five SQL recipes pass 45, 55, 20, 30, and 21 checks respectively.
The copied-data audit confirms Justin's one-player Regular overflow.
The full quality command passes.
The request and plan shapes remain unchanged.

### Phone evidence

WebKit uses a 390 by 844 mobile viewport and also checks 320 pixels.
It captures every requested state with saved light and dark preferences.
Screenshots finish modal animations before capture.
Each capture checks the action caption and its bounds.
The separate browser-tool capture uses Chromium at 390 pixels.
The original 320-pixel layout leaves only 70 pixels for the narrowest name.
The new layout leaves 244 pixels and reduces the tallest name from 48 to 16 pixels.
At 390 pixels, the narrowest name grows from 140 to 314 pixels.
The card-to-status gap stays within 16 pixels.

| State | Light | Dark |
| --- | --- | --- |
| Propose invalid | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-propose-invalid-light-390.png) | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-propose-invalid-dark-390.png) |
| Drop fixes proposal; Send enabled | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-propose-valid-send-enabled-light-390.png) | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-propose-valid-send-enabled-dark-390.png) |
| Accept already valid | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/valid-accept-valid-light-390.png) | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/valid-accept-valid-dark-390.png) |
| Incoming player moved to IR | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/valid-accept-incoming-ir-light-390.png) | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/valid-accept-incoming-ir-dark-390.png) |
| Accept invalid | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-accept-invalid-light-390.png) | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-accept-invalid-dark-390.png) |
| Drop fixes acceptance; Accept enabled | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-accept-fixed-enabled-light-390.png) | [390px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-accept-fixed-enabled-dark-390.png) |

Long-name evidence: [propose at 320px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/invalid-propose-long-names-320.png), [accept at 320px](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/valid-accept-valid-long-names-320.png).

The [old 320px layout](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/before/invalid-before-long-names-320.png) fails the same width check.

The [browser-tool capture](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/agent-browser-accept-390.png) confirms the same acceptance screen.

The [WebKit receipt](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/after/receipt.json) records 32 state captures and the row measurements.

### Trade move rule addendum

Trade controls call the Roster page's shared `isIREligible` and `isTaxiEligible` functions.
Only incoming players can enter Taxi.
Retained players can leave Taxi but cannot return through these controls.
Disabled controls share the Roster action row's opacity style.
The focused addendum checks pass 71 tests.

The [server regression](../tests/db/trade-retained-taxi-rejection.sql) first fails because the server accepts a retained Taxi move.
It now passes 16 checks, including save rejection, execution rejection, and changing eligibility.
The server uses `private.taxi_player_eligible`, as roster acquisitions do.
Retained Taxi moves fail with SQLSTATE `PT422` and detail `TRADE_TAXI_INCOMING_ONLY`.
Ineligible incoming choices fail at save with detail `TRADE_TAXI_INELIGIBLE`.
Execution checks eligibility again before any roster transfer.
All 46 trade SQL recipes pass on the private stack.
Three recipes replace formerly allowed retained Taxi moves with retained IR moves.
Their capacity, delayed execution, and rollback checks remain active.
The catalog and release attestations come from their generators.

Server files:

- `supabase/migrations/20261211000400_trade_taxi_incoming_only.sql`
- `supabase/sql/functions/by-name/private/check_trade_legality.sql`
- `supabase/sql/functions/by-name/public/set_trade_roster_plan_atomic.sql`
- `supabase/sql/functions/by-name/public/complete_accepted_trade_atomic.sql`
- `tests/db/trade-incoming-destinations.sql`
- `tests/db/trade-plan-moves-capacity.sql`
- `tests/db/trade-structured-legality.sql`
- `tests/e2e/db-security-catalog-attestations.json`
- `tests/e2e/release-history-attestations.json`

Addendum files:

- `components/roster/RosterItems.tsx`
- `components/roster/RosterPlayerSheet.tsx`
- `components/trades/TradeRosterPlanEditor.tsx`
- `tests/trade-roster-plan.test.ts`
- `tests/trade-legality-step.test.ts`
- `tests/components/player-eligibility-tags.test.ts`
- `tests/db/trade-retained-taxi-rejection.sql`
- `docs/interface-design.md`

### Trade review polish

Valid status contains only “Valid roster”.
Invalid status contains the title and the viewer's short reasons.
Other teams never appear in the status card.
Sectioned pick rows omit their route in both the Trades list and review screen.
Activity rows and standalone summaries retain their sender and recipient.
The focused polish checks pass 141 tests.
Another 58 row, card, and identity regression checks pass on Node 22.
The release check reads the migration order below and retains its negative controls.
The full Vitest run records 4,584 passes, six failures, and 48 skips.
All failing files pass their focused rerun after the release note and mock fixes.
Four failures use stale modules while polish files change during the full run.
The replay report failure coincides with the server commit during its source comparison.

Polish files:

- `components/trades/TradeCard.tsx`
- `components/trades/TradeLegalityScreen.tsx`
- `components/trades/TradePickLabel.tsx`
- `lib/trade-pick-label.ts`
- `lib/trade-roster-status.ts`
- `tests/components/pick-labels.test.ts`
- `tests/components/trades/pick-label-parity.test.ts`
- `tests/e2e/trade-legal-redesign.mjs`
- `tests/release-edge-compatibility.test.ts`
- `tests/trade-legality-screen.test.ts`
- `tests/trade-pick-label.test.ts`
- `docs/interface-design.md`

## Trade Taxi release order

Apply `20261211000400_trade_taxi_incoming_only.sql` before releasing the trade review changes.
Database, then Edge, then merge the frontend.
The migration keeps the RPC parameters and saved plan fields unchanged.
It rejects retained Taxi moves and checks incoming eligibility again at execution.

## Trade review verification handoff

The private stack uses only `pt4bafabletl` and the `614xx` ports.
The final capture uses WebKit with the iPhone 13 profile.
The final quality command passes lint, all type checks, function-source parity, and design checks.
The catalog generator produces no catalog change because function signatures and grants stay unchanged.
The release and security attestations are regenerated from the private database.

### Files changed from the release base

- [app/(modals)/propose-trade.tsx](<../app/(modals)/propose-trade.tsx>)
- [components/roster/RosterItems.tsx](<../components/roster/RosterItems.tsx>)
- [components/roster/RosterPlayerSheet.tsx](<../components/roster/RosterPlayerSheet.tsx>)
- [components/trades/PendingTradeRosterPlan.tsx](<../components/trades/PendingTradeRosterPlan.tsx>)
- [components/trades/TradeCard.tsx](<../components/trades/TradeCard.tsx>)
- [components/trades/TradeLegalityScreen.tsx](<../components/trades/TradeLegalityScreen.tsx>)
- [components/trades/TradeListRow.tsx](<../components/trades/TradeListRow.tsx>)
- [components/trades/TradePickLabel.tsx](<../components/trades/TradePickLabel.tsx>)
- [components/trades/TradeRosterPlanEditor.tsx](<../components/trades/TradeRosterPlanEditor.tsx>)
- [components/trades/TradeRosterPreviewList.tsx](<../components/trades/TradeRosterPreviewList.tsx>)
- [components/trades/acceptance-summary.ts](<../components/trades/acceptance-summary.ts>)
- [docs/interface-design.md](<../docs/interface-design.md>)
- [lib/trade-draft.ts](<../lib/trade-draft.ts>)
- [lib/trade-legality-step.ts](<../lib/trade-legality-step.ts>)
- [lib/trade-pick-label.ts](<../lib/trade-pick-label.ts>)
- [lib/trade-roster-status.ts](<../lib/trade-roster-status.ts>)
- [supabase/migrations/20261211000400_trade_taxi_incoming_only.sql](<../supabase/migrations/20261211000400_trade_taxi_incoming_only.sql>)
- [supabase/sql/functions/by-name/private/check_trade_legality.sql](<../supabase/sql/functions/by-name/private/check_trade_legality.sql>)
- [supabase/sql/functions/by-name/public/complete_accepted_trade_atomic.sql](<../supabase/sql/functions/by-name/public/complete_accepted_trade_atomic.sql>)
- [supabase/sql/functions/by-name/public/set_trade_roster_plan_atomic.sql](<../supabase/sql/functions/by-name/public/set_trade_roster_plan_atomic.sql>)
- [tests/app/propose-trade-ownership.test.ts](<../tests/app/propose-trade-ownership.test.ts>)
- [tests/components/pick-labels.test.ts](<../tests/components/pick-labels.test.ts>)
- [tests/components/player-eligibility-tags.test.ts](<../tests/components/player-eligibility-tags.test.ts>)
- [tests/components/trades/offer-refresh.test.ts](<../tests/components/trades/offer-refresh.test.ts>)
- [tests/components/trades/pick-label-parity.test.ts](<../tests/components/trades/pick-label-parity.test.ts>)
- [tests/components/trades/review-details.test.ts](<../tests/components/trades/review-details.test.ts>)
- [tests/db/trade-incoming-destinations.sql](<../tests/db/trade-incoming-destinations.sql>)
- [tests/db/trade-plan-moves-capacity.sql](<../tests/db/trade-plan-moves-capacity.sql>)
- [tests/db/trade-production-shaped.mjs](<../tests/db/trade-production-shaped.mjs>)
- [tests/db/trade-retained-taxi-rejection.sql](<../tests/db/trade-retained-taxi-rejection.sql>)
- [tests/db/trade-structured-legality.sql](<../tests/db/trade-structured-legality.sql>)
- [tests/e2e/db-security-catalog-attestations.json](<../tests/e2e/db-security-catalog-attestations.json>)
- [tests/e2e/release-history-attestations.json](<../tests/e2e/release-history-attestations.json>)
- [tests/e2e/trade-legal-redesign.mjs](<../tests/e2e/trade-legal-redesign.mjs>)
- [tests/e2e/trade-legal-server.mjs](<../tests/e2e/trade-legal-server.mjs>)
- [tests/e2e/trade-legality-browser.mjs](<../tests/e2e/trade-legality-browser.mjs>)
- [tests/release-edge-compatibility.test.ts](<../tests/release-edge-compatibility.test.ts>)
- [tests/trade-accept-legality.test.ts](<../tests/trade-accept-legality.test.ts>)
- [tests/trade-avatar.test.ts](<../tests/trade-avatar.test.ts>)
- [tests/trade-block-stats.test.ts](<../tests/trade-block-stats.test.ts>)
- [tests/trade-card-analyze.test.ts](<../tests/trade-card-analyze.test.ts>)
- [tests/trade-legality-screen.test.ts](<../tests/trade-legality-screen.test.ts>)
- [tests/trade-legality-step.test.ts](<../tests/trade-legality-step.test.ts>)
- [tests/trade-pick-label.test.ts](<../tests/trade-pick-label.test.ts>)
- [tests/trade-roster-plan.test.ts](<../tests/trade-roster-plan.test.ts>)

### New phone evidence

| State | Light, 390 px | Dark, 390 px |
| --- | --- | --- |
| Propose invalid | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-propose-invalid-light-390.png) | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-propose-invalid-dark-390.png) |
| Propose valid; Send enabled | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-propose-valid-send-enabled-light-390.png) | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-propose-valid-send-enabled-dark-390.png) |
| Accept valid; Accept enabled | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/valid-accept-valid-light-390.png) | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/valid-accept-valid-dark-390.png) |
| Incoming moved to IR | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/valid-accept-incoming-ir-light-390.png) | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/valid-accept-incoming-ir-dark-390.png) |
| Incoming moved to Taxi | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/valid-accept-incoming-taxi-light-390.png) | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/valid-accept-incoming-taxi-dark-390.png) |
| Trades list with a pick | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-trades-list-pick-light-390.png) | [Screenshot](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-trades-list-pick-dark-390.png) |

Additional proof: [invalid acceptance](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-accept-invalid-light-390.png), [repaired acceptance](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-accept-fixed-enabled-light-390.png), [320 px names](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/invalid-propose-long-names-320.png), [browser-tool capture](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/agent-browser-accept-390.png), [WebKit receipt](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/receipt.json).

The receipt contains 36 passing WebKit states and one separate browser-tool screenshot.
Both themes pass at 390 pixels, with long-name checks at 320 pixels.
The narrowest name grows from 70 to 244 pixels at 320 pixels.
At 390 pixels it grows from 140 to 314 pixels.
Every measured name stays 16 pixels tall.
The private stack is stopped after verification.

Final checks use Node 22.23.2.
`npm run check:quality` passes all included checks.
The changed browser recipe also passes `npm run typecheck:e2e` and scoped ESLint after selecting the iPhone profile.
The 15 focused test files pass 199 tests without failures.
The full run executes once on Node 22; the failing files pass targeted reruns.

Run the new server regression with the private database environment:

```sh
PANCAKE_TEST_DB_PORT=61422 psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-retained-taxi-rejection.sql
```

Server generation commands:

```sh
node --env-file=.env scripts/check-db-function-sources.mjs --write-catalog-manifest
PANCAKE_TEST_DB_PORT=61422 node --env-file=.env scripts/regenerate-release-history-attestations.mjs
node --env-file=.env scripts/check-db-function-sources.mjs --check-catalog
```

- [Full Vitest log](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/full-vitest.log)
- [Focused Vitest log](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/focused-vitest.log)
- [Row regression log](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/row-regressions.log)
- [Quality log](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/quality.log)
- [Trade SQL log](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/trade-sql.log)
- [Corrected work-queue invocation](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/work-queue-sql.log)
- [Taxi rejection log](/Users/michaelchen/Documents/pancake-season-mission/fable/program4/evidence/trade-ui-after/polish/taxi-rejection-sql.log)
