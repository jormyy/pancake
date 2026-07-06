# Instant Loading Plan

This is the checked-in operating plan for `~/Downloads/instant-loading-goal.txt`.
The source of truth for thresholds and workflow rank is
`tests/e2e/performance-budgets.json`.

## Top Workflows

| Rank | Workflow | Primary wait to remove | Measurement |
| --- | --- | --- | --- |
| 1 | Open Home and review live matchup/lineup | matchup, lineup, scoreboard, realtime refresh | `npm run e2e:browser-perf` |
| 2 | Change lineup day and move a player | day read plus atomic lineup RPC | `npm run e2e:browser-lineup` |
| 3 | Search/filter/sort the player pool | `search_players` RPC and projection enrichment | browser smoke plus player-search DB tests |
| 4 | Open a player detail screen | player row, averages, game log, fantasy points | full browser route sweep |
| 5 | Open roster and manage IR/taxi/picks/claims | roster, picks, claims, league-scored averages | `npm run e2e:browser-smoke` |
| 6 | Add a free agent or submit a waiver claim | transaction state, claim modal, atomic claim/add RPC | `npm run e2e:browser-waiver` |
| 7 | Review/propose/act on a trade | trade list, roster/pick candidates, trade action RPC | `npm run e2e:browser-trade` |
| 8 | Join auction draft room and place a bid | draft state, budgets, nomination, realtime fanout | `npm run e2e:browser-perf` |
| 9 | Open rookie draft room and make/observe a pick | draft board, rookie board, timer, pick RPC | `npm run e2e:browser-rookie-draft` |
| 10 | Open Dynasty Hub rankings/news | cached news and rankings first page | browser smoke plus dynasty static tests |

## Budgets

- UI feedback: under 100ms for common taps, filters, and text input.
- Cached or lightweight data request: under 300ms.
- Full workflow/page load: under 1s.
- Database hot query: target under 100ms.
- Browser long task: target under 50ms.

## Regression Gates

- `npm run perf:budget` validates the ranked workflow manifest and writes
  the ignored `tests/performance-budget-report.md` run artifact.
- `npm run e2e:browser-perf && npm run perf:budget -- --require-report`
  enforces the ignored structured browser perf report when a seeded E2E
  environment is available.
- `npm run e2e:data-latency` measures authenticated Supabase/PostgREST/RPC
  request latency for all top workflow ids. `npm run perf:budget` enforces this
  ignored report when present.
- `npm test` includes static guards for the performance manifest, player-search
  materialization, and first-paint read indexes.

## Latest Measurements

Validated on 2026-07-02 against the seeded E2E league and local Expo web server.

| Signal | Baseline | Current | Budget |
| --- | ---: | ---: | ---: |
| `search_players` first page RPC | 430.5ms median for 60 rows | 207.7ms median for 20 rows | 300ms |
| Player search input feedback | not previously gated | 26.1ms | 100ms |
| Auction bid press feedback | not previously gated | 0.6ms | 100ms |
| Full route sweep | not previously gated for all top routes | 289-323ms across measured top routes | 1000ms |
| Focused Home load under live update pressure | not previously gated | 329ms | 1000ms |
| Focused auction draft room load | not previously gated | 395ms | 1000ms |
| Browser long tasks under auction/home pressure | not previously gated | 0 long tasks | 50ms task target |

Current authenticated data workflow median totals are 195.7-331ms across all
10 ranked workflows. The first slow player-search measurement was taken before
the final page-size fix in this instant-loading pass; the current request keeps
infinite scroll for the full pool while reducing the critical first payload.

## Current Implementation Notes

- League membership, player search, roster, and Dynasty news keep cached data
  visible while refreshing.
- Home matchup/lineup and player detail screens hydrate same-day cached content
  immediately, then refresh in the background.
- Player search uses materialized read models and pages before projection
  enrichment so the request is bounded.
- Roster, matchup, trade, draft, waiver, and player detail hot reads have
  targeted indexes in the 2026-07-02 instant-loading migrations.
- Browser perf smoke measures live auction/matchup update pressure and fails on
  excessive heartbeat lag or slow mutation loops.
