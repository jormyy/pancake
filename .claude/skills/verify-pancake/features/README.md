# Pancake verification map

This map owns user-facing journeys for the real Pancake PWA.
Run the [skill](../SKILL.md) first and retain its evidence directory.

## Baseline preconditions

- The private stack is healthy and the exported app shows the seeded signed-in team.
- The browser uses this run’s unique session at 390×844, then 375×812.
- `fixture.json` names the current week, manager, opponent, bench player, and free player.
- Both teams have starters, bench players, IR, and taxi players.
- The league has a current matchup, a pending trade, and a pending waiver claim.
- The base seed includes auction and rookie drafts. The startup auction becomes completed for active-season journeys.
- A completed past season includes two regular-season games and a final. `fixture.json` records its expected standings and statistics.

## Driving conventions

- In every command, use `tools/verify/browser.sh "$EVIDENCE"` as `BROWSER`.
- `BROWSER` below is notation. Replace it with that complete command, or define a shell function with that body.
- Obtain dynamic names, dates, and refs from a fresh `snapshot -i`.
- Prefer exact names and `aria-label` selectors. Scroll controls into view before pressing them.
- Entry points are separate coverage obligations. A deep link does not prove navigation from a tab or sheet.
- Save before, action, and after screenshots, plus a full snapshot.
- For mutations, save `node tools/verify/observe.mjs "$EVIDENCE"` before and after.
- Recreate the disposable run after destructive journeys when later journeys need the original seed.

## Proof and failure reporting

Record the feature ID, entry point, viewport, expected result, actual result, and artifact names.
Check content, selected state, persistence, and database changes where applicable.
Report missing data as a failed precondition; never narrow a journey to make it pass.
Do not claim iOS home-screen behavior from Chromium viewport checks.

## Features

| Area | Coverage |
| --- | --- |
| [Sign-in](sign-in.md) | Sign-in, invalid input, sign-up, sign-out, restoration |
| [Home](home.md) | Matchup, day selector, team/player access, Auto-set sheet |
| [Roster](roster.md) | Starters, bench, IR, taxi, other-team roster |
| [Lineup](lineup.md) | Start, Auto, Bench pins, day selection, daily automation |
| [Players and Waivers](players-waivers.md) | Search, filters, rankings, news, claim/edit/cancel |
| [Trades](trades.md) | Builder, multi-team, offers, analyzer, block, history |
| [League](league.md) | Standings, schedule, activity, settings, history, bracket, picks |
| [Player](player.md) | Profile, statistics, season picker, news, roster actions |
| [Drafts](draft.md) | Auction, rookie draft, mock rooms, draft board |
| [Settings](settings.md) | Profile, theme, notifications, create/join, password |
| [PWA](pwa.md) | Update, offline banner, recovery, standalone limitations |
