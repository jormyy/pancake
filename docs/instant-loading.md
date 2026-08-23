# Instant Loading Plan

The performance operating plan. The source of truth for thresholds and workflow
rank is `tests/e2e/performance-budgets.json`.

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

Validated on 2026-08-23 against a seeded release build and local Supabase.

| Signal | Baseline | Current | Budget |
| --- | ---: | ---: | ---: |
| Home cold data-ready | 2337ms | 715ms | 1000ms |
| `search_players` first page RPC | 123.8ms median | 19.6ms median | 100ms |
| Home day feedback | not gated | 9.3ms | 100ms |
| Home warm request | not gated | 6ms | 300ms |
| Home live-update long tasks | not gated | 0 | under 50ms each |

All ten authenticated data workflows pass. Their median totals range from 9.6ms to 23ms.

Player search now uses a request-specific database plan. It keeps paging and projection behavior unchanged.

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
