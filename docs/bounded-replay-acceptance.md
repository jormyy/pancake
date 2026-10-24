# Saved replay through November 9

This matrix covers the saved 2024–25 season and October 21–November 9, 2025.
It does not require the rest of the 2025–26 season.
The original replay receipts retain their failures and source identities.
No settled date runs again during final preparation.

The evidence workspace is `/Users/michaelchen/.hermes/kanban/workspaces/t_4ba51e0d` (`W`).
Private Mini evidence remains under `/Users/michaelchen/pancake-t_4ba51e0d` (`T`).
Paths below start at `W/evidence` unless stated otherwise.

## Required outcomes

| Requirement | Result | Executed proof |
| --- | --- | --- |
| Preserve failure and validate recovery | Pass | `gpt23/rehearsal-comparison.json`: March 24 matches eight games, 286 stat rows and 42 client results; the 0.1-point control rejects. The rehearsal exit 1 remains recorded. |
| Finish season one and automatic playoffs | Pass | `gpt-turn3/transition-reconciliation.json`: 1,230 finals, 43,369 stat rows, three playoff results, champion, maxima and standings reconcile. |
| Trade deadline and offseason | Pass | Retained deadline action receipts; `gpt-turn3/stored-transition.json` and `rollover-pick-snapshots.json` preserve trade destinations, 72 pick assets and rollover ownership. |
| Real rookie draft and consumed picks | Pass | `gpt-turn5/draft-reconciliation.json`: 59 board identities, eight selections and eight consumed assets; traded pick ownership determines the slot owner. |
| Roster continuity at rollover | Pass | `gpt-turn3/rollover-stats-preservation.json` and `gpt-turn5/preservation-proof.json`: prior stats and roster ownership persist. |
| Actual opening and dynamic calendar | Pass | `gpt-turn7/calendar-reconciliation.json`: October 21 opens with two games; weeks contain 42, 52 and 53 NBA games. |
| First eligible matchups | Pass | `gpt-turn10/raw/active-week-scoring.json`: October 27 starts home–away2 and away1–away3; authenticated scores reconcile. |
| Live scoring and both eligible week closures | Pass | `gpt-turn11/raw` and `gpt-turn12/raw/milestone-2026-10-24T08-43-08-721Z.json`: eight score sides, maxima, winners, eight standings rows and two certificates reconcile. |
| Rookie identities, totals and in-app ranks | Pass | `gpt-turn12/raw/totals-2025-11-09-2026-10-24T08-43-09-799Z.json`: all 59 identities appear once; 551 raw listings, played-game counts, totals, averages and FP/game ordering reconcile. |
| Fantasy rookie trade and new-owner points | Pass | `gpt-turn10/raw/new-owner-live-scoring.json` and final raw boxes: Flagg trades October 28 and scores for the new owner October 29. |
| Rookie drop, automatic return and later scoring | Pass | `gpt-turn12/raw/drop-reconciled-2026-10-24T08-43-09-700Z.json`: Knueppel returns November 6 at 03:00 Eastern and scores 50.6 starter points November 7. |
| NBA transfer identity continuity | Pass, retained | Earlier first-season Anthony Davis transfer proof remains retained. No actual NBA transfer occurs within the second-season cutoff. |
| Fresh Realtime numeric and final delivery | Pass, bounded window | `gpt-turn12/raw/final-realtime-reconciled-2026-10-24T08-53-17-302Z.json`: 91 events, a numeric contribution and both final matchup rows agree with authenticated stored results. |
| Cutoff and settled-history guards | Pass | `gpt-turn12/raw/final-audit-guard-2026-10-24T08-56-16-306Z.json`: 147 finals and 5,134 unique stat rows; no later stats or finals; all 16 business guards match. |
| Meaningful mutation checks | Pass, stated scope | Four retained recovery/cutoff controls fail on assertions. Final preparation records scoped pruning controls separately in `gpt-turn13`; no universal mutation claim follows. |
| Final preparation and required checks | See final receipts | `gpt-turn13`: cleanup, pruning measurements, exact commands, exits, dependency audit and final suite results. Publication remains held for Forge review. |

Fantasy week 1, October 21–26, is deliberately skipped in the league settings.
Its NBA stats still count in player totals.
The cutoff covers three NBA calendar weeks and two scored fantasy weeks.
It does not move to November 16.

## Retained limits

The original long Realtime probe exits 1 with 59.5 versus 144.8.
Its checkpoint remains `complete=false`.
The failed source, state and receipts remain at `T/orch/keep-realtime-failure-gpt33`.
The new delivery watch proves only its recorded window.
Missing original channel traces prevent sole-cause proof or retrospective certification of the lost stream.
The renewal fix passes unit and real short-TTL channel checks; no full patched replay runs.

These provenance limits remain explicit even when bounded scoring and final preparation pass.
They do not authorize another run over settled dates.
A resumed bounded segment also cannot claim a fresh, uninterrupted two-season `fullAcceptance` result.

External dynasty forecasts, projections and complete career totals have incomplete inputs.
Required in-app FP/game ranks pass independently of those sources.
Marković, Niang and Mashack have no raw box listing within the cutoff.
Their canonical identity and search presence pass; an appearance that does not exist cannot be tested.

The later second-season playoffs, later NBA transfers, real push-provider delivery and native iOS PWA behavior are outside this bounded proof.
Earlier cadence/timing and ancillary-job limits remain recorded in the historical reports.
Original evidence and user apps remain untouched during final preparation.
