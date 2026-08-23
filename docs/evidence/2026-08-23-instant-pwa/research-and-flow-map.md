# Research and flow map

Research date: 2026-08-23.

## Official examples

| Source | Observation | Decision |
| --- | --- | --- |
| [ESPN Fantasy app](https://www.espn.com/espn/apps/fantasy) | ESPN leads with team management and live scores. | ADOPT: keep the current matchup and lineup on Home. |
| [ESPN app launch, 2025-08-21](https://espnpressroom.com/press-release/espn-launches-new-direct-to-consumer-service-enhanced-espn-app/) | The app joins live stats, fantasy results, and personalized context. | ADOPT: show live scores beside lineup actions. |
| [ESPN app guide, 2025-08-21](https://espnpressroom.com/feature/dtc-launch-week-a-sports-fans-guide-to-the-enhanced-espn-app/) | Live panels reduce context changes during games. | ADOPT: keep scoring, dates, and lineup controls together. |
| [ESPN brand system, 2026-03-27](https://espnpressroom.com/feature/espns-new-brand-identity-built-for-how-fans-live-sports/) | One system stays consistent across screens and platforms. | ADOPT: keep Pancake tokens across mobile and desktop. |
| [Splitwise offline release, 2013-04-16](https://blog.splitwise.com/2013/04/16/presenting-splitwise-v3-fat-rabbit/) | Cached data stays visible offline and syncs after reconnect. | ADOPT: keep safe cached reads and refresh on reconnect. |
| [Splitwise offline support, 2015-09-16](https://feedback.splitwise.com/forums/162446-general/suggestions/2918520-offline-mode-for-mobile) | Offline changes sync later and show pending state. | ADOPT the visible stale state. REJECT queued lineup writes. |
| [Splitwise usage guide](https://kb.splitwise.com/getting-started/how-do-i-use-splitwise) | Main actions use short verbs and direct entry points. | ADOPT: use direct labels such as Auto, Players, and Trades. |

Pancake rejects ESPN video, betting, commerce, and streaming patterns. They do not support fantasy roster work.

Pancake rejects Splitwise-style offline writes. Lineup locks and live roster conflicts need a server decision.

Pancake rejects peer-to-peer offline sync. Server recovery is simpler and safer.

## Measured flow map

Tap counts start on the current mobile tab. Typing does not count as a tap.

| Task | Flow | Safe taps | Proof |
| --- | --- | ---: | --- |
| Open the current matchup | Launch Pancake | 0 | Home opens the matchup. |
| Return to the matchup | Tap Match | 1 | Match stays in the bottom bar. |
| Change the lineup day | Tap one day | 1 | Feedback measured 9.3 ms. |
| Swap two lineup slots | Tap player, tap valid target | 2 | Invalid and locked targets reject input. |
| Auto-set today | Tap Auto, tap Today | 2 | Stored lineup and refresh pass. |
| Auto-set the season | Tap Auto, tap Rest of Season | 2 | Two future dates persist. |
| Find a player | Tap Players, tap Search, type | 2 | The first page takes 19.6 ms median. |
| Filter players | Tap Players, tap one filter | 2 | Server filtering keeps stable paging. |
| Review the roster | Tap Roster | 1 | Roster remains a primary tab. |
| Review trades | Tap Trades | 1 | Trades remains a primary tab. |

The six mobile tabs fit at 390 pixels without clipping. Hiding one would add a tap to a primary task.

No layout change follows from this review. The delivered layout already applies the adopted points.
