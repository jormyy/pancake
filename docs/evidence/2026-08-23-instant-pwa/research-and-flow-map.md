# Research and flow map

Research date: 2026-08-23. Current public pages were checked again on this date.

## Current ESPN evidence

| Source | Current observation | Decision |
| --- | --- | --- |
| [ESPN Fantasy app](https://www.espn.com/espn/apps/fantasy) | ESPN names team management and live scores as core jobs. | ADOPT: open Pancake on the live matchup. |
| [ESPN Fantasy changes for 2025](https://support.espn.com/hc/en-us/articles/39730562109204-ESPN-Fantasy-App-What-s-New-in-2025) | Home shows timely modules. Roster shows a manager dashboard. Matchup keeps the score visible. Player cards keep actions near the header. | ADOPT the task priority. REJECT editorial and betting modules. |
| [ESPN lineup guide, updated 2026-08-11](https://support.espn.com/hc/en-us/articles/360000093672-Setting-Your-Lineup) | The mobile path starts in Roster. A manager selects one player, then one valid slot. ESPN saves the move and confirms it. Quick Lineup covers one day or the full matchup. | ADOPT the two-tap move and direct Auto control. Keep Pancake's rest-of-season choice for dynasty play. |
| [ESPN free-agent guide](https://support.espn.com/hc/en-us/articles/360058028831-How-to-add-a-Free-Agent) | The path starts in Players. Add and Claim use distinct states. A required drop appears before confirmation. | ADOPT the Players entry and state-specific action. Keep server checks before a roster write. |
| [ESPN Fantasy alerts](https://support.espn.com/hc/en-us/articles/47079238819092-ESPN-Fantasy-App-and-Alerts) | A fantasy alert opens the related matchup. | ADOPT direct links to live context. REJECT a separate notification destination. |

ESPN's public pages expose Home, Roster, Matchup, Players, and League as task names. They do not publish a stable left-to-right tab order.

Pancake therefore uses ESPN's task priority, not an inferred copy of its tab bar.

## User guidance

| Source | User need | Decision |
| --- | --- | --- |
| [Apple tab bars, updated 2026-06-08](https://developer.apple.com/design/human-interface-guidelines/tab-bars) | Tabs should hold stable top-level destinations. Actions belong in a toolbar or view. Labels should use clear words. Six or more tabs need another design. | ADOPT: remove Draft and Profile actions from the native tab bar. Keep six stable destinations. |
| [Apple feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | Feedback should show status, success, failure, and recovery near the affected item. | ADOPT: keep save, stale, offline, and retry feedback in context. |
| [Apple design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles) | Familiar words, consistent behavior, clear feedback, and easy recovery reduce learning cost. | ADOPT: use Matchup, Roster, Players, Trades, Dynasty, and League in that order. |
| [WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Larger, spaced targets reduce wrong taps. | ADOPT: keep full-row targets and at least 24 CSS pixels. Aim for 44 pixels on main actions. |
| [WCAG 2.2 error identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification) | Text must identify an error and the affected input. | ADOPT: keep specific lock, roster, waiver, and network errors. |

## Tab comparison

| Platform | Before | Delivered order | Reason |
| --- | --- | --- | --- |
| Pancake web | Matchup, Players, Dynasty, Roster, Trades, League | Matchup, Roster, Players, Trades, Dynasty, League | Live work comes before analysis. |
| Pancake native | Home, Players, Dynasty, Roster, Trades, Draft, League, Profile | Matchup, Roster, Players, Trades, Dynasty, League | Draft stays in League. Profile stays in League settings. |
| ESPN public task paths | Home, Roster, Matchup, Players, League | Comparison only | ESPN does not publish exact tab positions. |

## Measured flow map

Tap counts start on the current mobile tab. Typing does not count as a tap.

| Task | Flow | Safe taps | Proof |
| --- | --- | ---: | --- |
| Open the current matchup | Launch Pancake | 0 | Home opens the matchup. |
| Return to the matchup | Tap Matchup | 1 | Matchup stays in the tab bar. |
| Change the lineup day | Tap one day | 1 | Feedback measured 9.3 ms. |
| Swap two lineup slots | Tap player, tap valid target | 2 | Invalid and locked targets reject input. |
| Auto-set today | Tap Auto, tap Today | 2 | Stored lineup and refresh pass. |
| Auto-set the season | Tap Auto, tap Rest of Season | 2 | Future dates persist. |
| Find a player | Tap Players, tap Search, type | 2 | The first page takes 19.6 ms median. |
| Filter players | Tap Players, tap one filter | 2 | Server filtering keeps stable paging. |
| Review the roster | Tap Roster | 1 | Roster is the second primary tab. |
| Review trades | Tap Trades | 1 | Trades remains a primary tab. |
| Open a draft | Tap League, tap Auctions or Draft Board | 2 | Draft is a league action, not navigation. |
| Open profile settings | Tap League, Settings, Profile | 3 | Profile is secondary account work. |

The six stable mobile tabs fit at 390 pixels. Draft and Profile no longer compete with daily gameplay.
