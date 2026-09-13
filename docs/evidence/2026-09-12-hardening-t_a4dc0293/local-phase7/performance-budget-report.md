# Performance Budget Check

- Status: PASS
- Generated: 2026-09-13T01:10:30.557Z
- Browser perf report: present
- Data latency report: present

| Rank | Workflow | Route | Feedback/Cached/Full | Measurement |
| --- | --- | --- | --- | --- |
| 1 | Open Home and review live matchup/lineup | / | 100/300/1000ms | npm run e2e:browser-perf |
| 2 | Change lineup day and move a player | / | 100/300/1000ms | E2E_BROWSER_FULL_SWEEP=1 npm run e2e:browser-smoke |
| 3 | Search/filter/sort the player pool | /players | 100/300/1000ms | E2E_BROWSER_FULL_SWEEP=1 npm run e2e:browser-smoke |
| 4 | Open a player detail screen | /player/[id] | 100/300/1000ms | E2E_BROWSER_FULL_SWEEP=1 npm run e2e:browser-smoke |
| 5 | Open roster and manage IR/taxi/picks/claims | /roster | 100/300/1000ms | npm run e2e:browser-smoke |
| 6 | Add a free agent or submit a waiver claim | /players, /claim-player | 100/300/1000ms | E2E_BROWSER_FULL_SWEEP=1 npm run e2e:browser-smoke |
| 7 | Review, propose, accept, reject, withdraw, or veto a trade | /trades, /propose-trade | 100/300/1000ms | E2E_BROWSER_FULL_SWEEP=1 npm run e2e:browser-smoke |
| 8 | Join auction draft room and place a bid | /draft-room | 100/300/1000ms | npm run e2e:browser-perf |
| 9 | Open rookie draft room and make/observe a pick | /rookie-draft-room | 100/300/1000ms | E2E_BROWSER_FULL_SWEEP=1 npm run e2e:browser-smoke |
| 10 | Open Dynasty Hub rankings/news | /dynasty | 100/300/1000ms | npm run e2e:browser-smoke |

