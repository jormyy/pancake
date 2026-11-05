# Frozen local baseline

No optimization is applied. These measurements rank the next experiments.

Source: `475873c6ba4891d351091e9dc045c25b30febab9`. Harness: `40e3108f8c3a59fb46be91b29c8748010ef32df34b8f083e00ce2a1e84bee8da`.
Runs: 2026-11-04T19:57:38.387Z and 2026-11-04T19:59:48.510Z. Both commands exit 0 and stop their stacks.

## Workload and method

The seed has 30 leagues, 12 teams per league, 600 players, 1230 games, and 49200 stat rows.
It has 15600 weekly projections and 49200 daily projections.
There are 5400 roster rows, 23040 lineup rows, and 4680 matchups.
The database occupies 210,783,379 bytes and has a 512 MiB memory limit.
The fixture reuses the existing season seed and current aggregation SQL. Its schedule moves with the clock to preserve the same season phase.
Each RPC uses three warmups and 15 measured authenticated reads. Response bytes are decoded JSON body bytes.
Each hot loop uses 15 timed batches. The optimizer operation covers 18 players, 10 slots, and seven dates.
The overlay covers six matchups, 216 roster players, 15 games, and 450 live lines. Trade valuation covers 12 assets and 216 roster players.
Browser rows use five cold/warm pairs, 390×844 Chromium, and 4× CPU throttle. Fresh contexts keep local authentication only.
Warm visits preserve browser and app caches. External browser traffic uses a closed proxy.
Meaningful paint follows visible seeded players and usable screen controls. Interactive time ends after a successful day change or opening the lineup sheet.
Interactive time includes automation overhead. Static files use local uncompressed delivery. These are not installed iPhone or Safari measurements.
SQL and CPU profiling run outside reported timing samples. Heap allocation counts are not measured.
Cold database latency, network throttling, and concurrent load are not measured.

## RPC baseline

| Screen | First p50 ms | Second p50 ms | Second p95 ms | Bytes | p50 noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home | 18.03 | 18.93 | 20.21 | 32339 | +4.99% |
| Roster | 3.44 | 3.88 | 4.78 | 44730 | +12.88% |
| Lineup | 2.16 | 2.23 | 2.47 | 19184 | +3.23% |
| Players/Waivers | 18.07 | 18.50 | 20.22 | 81094 | +2.41% |
| Trades | 9.13 | 9.46 | 12.61 | 68271 | +3.60% |
| League | 5.08 | 5.22 | 6.27 | 4939 | +2.74% |
| Player | 2.77 | 3.22 | 3.55 | 5826 | +16.22% |

## Browser baseline

| Screen / cache | Paint p50 ms, first → second | Paint p95 ms | Interactive p50 ms, first → second | Paint noise | Interactive noise |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home / cold | 1075.80 → 1075.90 | 1188.90 | 1620.70 → 1624.10 | +0.01% | +0.21% |
| Home / warm | 687.60 → 683.10 | 689.60 | 902.40 → 899.50 | -0.65% | -0.32% |
| Roster / cold | 981.20 → 983.40 | 993.40 | 1101.80 → 1085.20 | +0.22% | -1.51% |
| Roster / warm | 624.90 → 633.40 | 643.50 | 721.30 → 755.50 | +1.36% | +4.74% |

Total production JavaScript is 2,707,073 bytes.

| Initial route | Static initial JavaScript bytes |
| --- | ---: |
| / | 2073650 |
| /league | 2171510 |
| /lineup | 2100549 |
| /player/[id] | 2062978 |
| /players | 2148386 |
| /roster | 2102605 |
| /trades | 2109239 |

The JSON includes every route, chunk, digest, transferred size, percentile, sample, and noise value.

## Hot loops

| Complete operation | First median ns/op | Second median ns/op | Second range ns/op | Noise |
| --- | ---: | ---: | ---: | ---: |
| chooseAutoSetAssignments | 1257087.09 | 1300395.87 | 1242192.63–2699937.50 | +3.45% |
| overlayLiveScores | 352020.38 | 364634.24 | 356165.76–416666.67 | +3.58% |
| analyzeDynastyTrade | 29561.48 | 29464.27 | 28836.73–32403.32 | -0.33% |

## Sensitivity and work checks

| Run / section | Errors | Work done | Slowdown ratio | Separated ranges |
| --- | ---: | ---: | ---: | --- |
| First / data | 0 | 153 | 158.24× | true |
| First / client | 0 | 30 | 3.05× | true |
| First / hot | 0 | 9190 | 3.96× | true |
| Second / data | 0 | 153 | 120.51× | true |
| Second / client | 0 | 30 | 3.04× | true |
| Second / hot | 0 | 9265 | 3.96× | true |

Each section uses five alternating control/slow pairs. Challenges add a one-second RPC delay, a two-second document delay, or four optimizer executions.
Challenge work is excluded from baseline samples. No application source contains a slowdown.
All outputs are consumed and checked. Invalid live IDs failed the overlay gate during development; valid IDs pass it.

## Limiters and limits

The host has 15 logical cores. Load averages are 6.37, 5.10, 5.48 and 7.28, 5.77, 5.68.
The Mac also runs other work. Two complete runs measure repeatability; they do not establish a performance improvement.
The browser spends much longer reaching useful content than any single RPC. Shared script execution and layout are the first places to investigate.
The separate CPU profile identifies optimizer cost-vector subtraction, game-time parsing, and decimal score arithmetic.
The SQL profile records actual nested statements, row counts, and buffer use. Nested costs overlap and must not be added.

## Ten ranked hypotheses

Expected gain is a priority estimate. Every hypothesis requires a separate before/after experiment.

| Rank | Mechanism and experiment | Expected user-visible gain | Data-oriented layout? |
| --- | --- | --- | --- |
| 1 | Split or remove unused modules from `__common-4f46e48088617bac362a5fe3d9c9e101.js` (1,063,939 bytes). | High; shared cost on every cold screen. | No; dependency and chunk boundaries. |
| 2 | Trace eager imports in `entry-75f0c0b27db30b5739bad1e72010f825.js` (971,296 bytes). Defer inactive features. | High; another large shared startup cost. | No; loading boundaries. |
| 3 | Batch the `useFittedText` style writes and width reads used twice per `MatchupRow`. | Medium; Home has measurable layout cost and repeated observers. | No; DOM read/write order. |
| 4 | Make `screen-cache.ts` restore persisted entries once per storage revision. Avoid repeated key scans and JSON parsing. | Medium, unproved; target warm startup. | Yes; keep a stable indexed in-memory cache. |
| 5 | Bound `private.live_score_basis` in `view_home` to required matchup/date inputs. | Small per open; profile attributes much of Home SQL to this query. | Yes; smaller relational working set and indexes. |
| 6 | Reduce `view_player_search` projection work before sorting and limit `view_players` ownership/claim payloads. | Small per search, potentially repeated; the largest measured response. | Yes; project narrow columns and avoid repeated wide joins. |
| 7 | Narrow `get_trade_cards` inside `view_trades`, or defer detail fields until a card opens. | Small per open; 40 seeded offers produce a large response. | Yes for narrow relational rows; no client layout change required. |
| 8 | Replace allocated cost vectors in `chooseAutoSetAssignments` with reusable numeric buffers. Cache parsed game times. | Low at this size; one roster-week currently costs about a millisecond. | Yes; flat cost storage and index handles. |
| 9 | Index snapshot games and provider IDs once in `overlayLiveScores`; avoid repeated filters and decimal conversions. | Low per tick; confirm actual tick frequency before changing it. | Yes; keyed lookup plus packed hot fields. |
| 10 | Index roster players once in `analyzeDynastyTrade`; avoid repeated `flatMap`, `filter`, and `find`. | Very low for this trade size; leave it unless scale changes. | Yes; player/member indexes or flat ownership arrays. |

## Handoff

Run `node tools/perf/run.mjs` twice. The second JSON reports per-metric noise against the first successful matching run.
Run `node --test tools/perf/harness.test.mjs` and `node node_modules/eslint/bin/eslint.js tools/perf/*.mjs`.
Four targeted tests pass. The CLI exercises the database seed, seven RPCs, real browser controls, and all three hot loops.
The selector reports new files as unmapped and matches unrelated tests by filename. No full suite runs.
Changed files under `tools/perf/`:

- `run.mjs` and `common.mjs` run measurements and compute summaries, sensitivity, and noise.
- `database.mjs` and `seed.sql` create the private database and season fixture.
- `client.mjs` and `edge.mjs` build and measure the real web app locally.
- `hot.mjs` and `profile.mjs` measure and profile the existing business loops.
- `harness.test.mjs` checks measurement failures and real workload outputs.
- `README.md` documents the command in 24 lines; `.gitignore` excludes temporary artifacts.
- `baseline.json` preserves both complete runs; `BASELINE.md` provides this handoff.

Files change only under `tools/perf/`. No package, app, database source, or root configuration changes.
No commit, staging, push, deployment, or hosted database access occurs. Both private stacks stop and delete their volumes.
Keep these measurement inputs fixed during later experiments. Do not rerun the retired mini-host launcher for this baseline.
Nothing remains for this measurement lane. Next work is choosing and testing one ranked hypothesis.
