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
| `fontSize` | Small type | `2xs` 10, `xs` 11, `2sm` 12, `sm` 12, `md` 13px |
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
| `scoreboardColors` | Scoreboard surfaces and states |
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
| `segmentedControl` | 44px minimum target, 12px horizontal padding, 2px tab underline |
| `textLink` | 44px minimum target and 20px line height |
| `lineupControls` | 44px targets; 13px labels; season action receives 1.4 times the width |
| `daySelector.compact` | 2px gaps above, below, and between date targets |
| `sheet` | 560px maximum width, 52px header, 16px content padding |
| `sheet` | Phone height at most 88%; desktop height at most 86% |
| `sheet` | 20px phone corners; 16px desktop corners |

Minimum heights allow enlarged text to increase the layout height.
Player names and metadata wrap instead of hiding information.
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

## Preserved information and labels

Phone Players and Block rows keep 28px headshots and 13px names.
Other shared player rows keep 32px headshots.
All interactive filters and buttons retain at least 44px targets.
The compact lineup header stays 49px at standard text size.
The mobile shell keeps its 56px default top bar.
Long league names wrap and can increase its height.
The content inset follows the measured bar height.
Profile names, email values, pick labels, and activity titles also wrap.
Bid inputs, scoring weights, notification headings, and account links use the 44px target floor.

Lineup actions remain Today, This week, and Rest of season.
Their labels remain Auto-set today, Auto-set this week, and Auto-set rest of season.
The automatic switch keeps the name Keep lineup updated automatically.
Its visual switch creates no second accessible target.
The sheets retain Edit lineup manually.
Home and Roster retain Open auto-set lineup options.
One-time actions do not change the saved automatic preference.
Every empty starter, bench, IR, and taxi place remains visible.

Matchup player names retain their full accessible names and injury labels.
Phone labels use the first initial and full surname, including suffixes.
The 24px face stays beside the label.
Profile, points, and slot targets remain separate.
Only points open the scoring breakdown.
No-game rows omit team abbreviations and OFF text.
Game rows retain bold away-at-home labels.
Live rows retain their points, rebounds, assists, and live state.
Other matchups retain both scores and Final status.

DTD, GTD, and day-to-day injury values use the same red as Out.
`T:12` means taxi eligibility or occupancy with 12 stored career regular-season games.
`T:—` means the count is unknown.
Known ineligible taxi occupants retain a warning and an explicit accessible label.
[Taxi rules](roster-lifecycle.md) define eligibility and server authority.

Missing fantasy-point and minute averages display as `0.0 FP · 0.0 mins`.
Their table cells display `0.0`.
Other unknown statistics retain their unknown markers.
These defaults do not change stored statistics or scoring.
News titles retain 13px text with 16px line height.
News summaries retain 13px text with 18px line height.
News rows retain 8px vertical padding and 4px content gaps.
Titles, summaries, and sources wrap fully.

Recent games retain MIN beside fantasy points.
Minutes use one decimal place, including zero.
DNP and unknown minutes remain distinct.
Narrow tables scroll horizontally.
Near-end scrolling reveals 15 cached rows without another data request.
Player and season changes reset the visible page.
Retry, empty, complete, and manual paging states remain available.

Asset values wrap fully, with each range on its own line at phone widths.
Trade review retains each over-limit team's required drop count.
Saved estimate and sources opens the original quote and frozen inputs.
Revalue with current inputs leaves the original quote unchanged.
The League pick bank includes original and acquired picks, with known zero counts visible.

## Verification

Run focused tests for the changed components and their consumers.
Run lint and both app and test typechecks.
Run browser checks on the mini.

| Test | Evidence |
| --- | --- |
| `tests/ui/design-system.test.ts` | Default sizes, accessible labels, formatting, and one-edit header propagation |
| `tests/ui/client-layout.test.ts` | WebKit row captures at 360px and 390px, with text scale 1 and 1.3 |
| `tests/ui/shared-layout.test.ts` | Shared control bounds, unclipped text, and compact header geometry |
| `tests/components/player-eligibility-tags.test.ts` | Injury, rookie, and taxi labels across consumers |
| `tests/app/lineup-optimizer-lifetime.test.ts` | Compact lineup header and automatic preference behavior |
| `tests/app/lineup-empty-slots.test.ts` | Empty lineup places and target behavior |
| `tests/app/roster-empty-slots.test.ts` | Roster section labels and empty places |

Save screenshots outside the repository under the mission's `design-system` evidence directory.
Component captures do not prove every release screen fits.
The final release requires before and after captures of every screen at both widths and text scales.
`tests/ui/release-design-capture.mjs` captures all routes and League panels from the shared sweep fixture.
It measures targets, clipped text, overlapping targets, document overflow, and the compact lineup header.
The capture scales text once after fonts load, then forces row remeasurement.
Icon fonts retain their fixed size, as the icon library requires.
The report checks title sizes against the requested scale.

The release runner uses only loopback ports 59721, 59790, and 59791.
It blocks other browser requests.
Use the lane's generated environment and seed state.

```sh
node tests/ui/release-design-capture.mjs \
  --env=../local/local-stack.env --state=../local/tests/e2e-state.json \
  --output=../evidence/design-system --label=before \
  --compare=http://127.0.0.1:59791
```

Serve the baseline on 59790 and the candidate on 59791.
A partial rerun uses `--surfaces=players,profile` and `--frontend=http://127.0.0.1:59791 --label=after`.
The report records source markers and bundle digests.
The file hashes in the handoff identify uncommitted source changes.
Set `PANCAKE_PREVIOUS_RELEASE_ROOT` to a local stamped export before building the candidate.
Set `TMPDIR` to a private directory inside the lane folder.
Concurrent Metro builds can otherwise reuse transformed modules with another lane's public environment values.
A bootstrap export can temporarily move `release-predecessor.json` outside the checkout, with a trap that restores it.
Never use the pinned hosted predecessor for local verification.

Authenticated seeds use the app's mutation fetch wrapper.
It gives each logical write a request ID and retains that ID for a transport retry.
The design fixture completes the startup draft before it proposes a trade.
A separate mock auction supplies the live room screen.

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
Run it with the project's Playwright Chromium installed.
Exports include header densities, favicon, Expo icon, boot logo, Apple touch icon and PWA icons.
Install icons use opaque backgrounds.
Header and favicon exports retain rounded transparent corners.
The mark stays inside the maskable safe region.
The launch background matches the icon background. Browser chrome retains the app's theme color.

## Recent games

Every game row includes MIN beside fantasy points. Minutes use one decimal place, including zero; DNP rows retain their DNP label. Missing game minutes display an em dash; they remain distinct from a played zero-minute line. Narrow screens scroll the table horizontally so headers and minute values stay readable.

On iPhone web layouts, scrolling near the game table’s end reveals the next 15 games. The observer uses the actual vertical scroll container. It does not wait for transaction history below the table. Existing rows retain their keys and scroll position.

The game-log read supplies the season’s available regular-season games. Averages can load independently. Paging reveals cached rows and makes no extra network request. Repeated near-end events reveal one page per render. Duplicate NBA game identities appear once. Changing the player or season resets the visible page.

A failed season read shows Retry. Existing rows remain visible during recovery. Empty seasons show “No games available.” Completed logs show “All games shown.” Desktop, native and browsers without IntersectionObserver retain the manual paging control.


## Lineup

Lineup uses the shared compact page header.
Back controls retain 44px touch targets and safe-area spacing.
Two compact control rows sit directly below the title, without a card title or divider.
The first row has Today, This week, and Rest of season buttons with single-line 13px labels.
Rest of season gets extra width to keep its full label visible at larger text sizes.
Rest of season sets the remaining season dates. Its accessible label remains Auto-set rest of season.
Home uses the shared lineup controls directly.
Roster and Home's matchup details retain Auto-set with the accessible label Open auto-set lineup options.
Their sheets use Today, This week, Rest of season, and Edit lineup manually.
The second row places Keep updated automatically on the left and the switch on the right.
The whole row acts as one switch with the accessible name Keep lineup updated automatically.
The visual switch does not create a second accessible control.
Both rows keep 44px touch targets.
Keep updated automatically controls the saved daily preference. One-time actions leave this switch unchanged.
Action labels stay on one line at 360px and 390px, including text scale 1.3.
The horizontal day row sits directly below the automatic switch and above Starters.
Its shared compact spacing leaves a 2px gap above and below the date targets.
The controls and first section add no extra vertical padding.
Other section labels keep their existing spacing.
Every empty starter, bench, IR, and taxi place remains individually visible.
Players and slots retain the manual move flow. Offline and read-only states disable lineup changes.


## Trades

Asset values wrap fully. Each range appears on its own line at phone widths.
Review trade states how many players an over-limit team must drop to accept.
The count comes from the displayed regular, IR, and taxi roster counts.
Saved estimate and sources opens the original quote and its frozen inputs.
Revalue with current inputs opens a separate calculation for the saved trade.
Revaluation leaves the original quote unchanged, including after settlement.


### Compact fantasy screens

Use the last word before any suffix as the surname.
Matchup names use the first initial and surname when the surname has seven characters or fewer.
Longer surnames show only their first ten characters, with no ellipsis or trailing hyphen.
Remove suffixes such as Jr., Sr., II, III, IV, and V before this rule.
One-word names use the same ten-character cap.
Keep the full name in the profile button label.
Matchup headshots sit beside the centre position column.
Names and injury badges extend outward in mirrored rows.
Names and game lines each occupy one line.
Forecast lines show rounded final points and the supplied win probability.
Final points include the current score and all projected remaining games for each team.
Missing final points or odds show an em dash.
Do not substitute projected point share for a win probability.
The claims count remains visible at zero, directly beside Auto-set.
Zero opens Players; positive counts open Waivers.
Both controls have a minimum height of 44 pixels.
Player projections use one opponent, time, and points line, with source details in a smaller caption.
Trade assets use one name line, one team and positions line, and one value line.

### Waivers copy and claims navigation

Keep the budget, priority, next run, and pickup count above pending claims.
Show `Pickups 0/2 this week`.
Leave bid rules and dropped-player hold rules out of this section.
Keep actionable error and offline messages.
The browser check verifies counts 0, 1, and 3 on an iPhone 14 at 390×844.
It also captures a player with an upcoming projection.
Run this check only against the private 588xx stack.

```sh
node tests/ui/claims-navigation.mjs \
  --stack-env=../local/polish/local-stack.env \
  --state=../local/polish/tests/e2e-state.json \
  --output-dir=../evidence/claims \
  --label=after
```
## Navigation

Home follows the daily job: read the matchup, fix the lineup, then check waivers.
Live points and win odds appear first. The full lineup editor appears directly below them.
Today, This week and Rest of season actions use the same editor on Home and its own route.
The automatic switch saves the same team preference. Tap a player, then its destination to swap.
Locked players stay in place. Matchup comparison sits behind Matchup details.
Pending claims, the next run and available FAAB appear after the lineup. Claim editing opens directly from Home.
Players and Trades remain one tap away. Players groups search, Waivers, Rankings and News.
League opens clear sections for league information, team tools, draft rooms, accounts and commissioner controls.
Profile, draft rooms and commissioner tools live inside those sections.
Controls keep their accessibility names. Navigation targets stay at least 44 pixels.
The shell keeps safe-area spacing. New forms use the existing input components.
The [feature map](supabase-backend-route-inventory.md#navigation-feature-map) records each entry and its tap count.

Navigation checks use local manager and commissioner accounts in WebKit at 390×844.
All 25 routes appear in 66 screen checks. Thirty-five entry checks verify the visible paths.
Lineup swaps take two taps. Pending claims open in one tap. Measured navigation and lineup targets meet 44 pixels.
The timeline route loads team events. A failed import shows a retry control.
