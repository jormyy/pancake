# Database performance and capacity

## Measurement scope

Measurements date from October 18, 2026. Hosted reads contain metadata and aggregates only.
The local benchmark uses 600 players, 240,360 stat rows, six historical seasons, and three leagues.
Each authenticated HTTP query runs once, then repeats ten times. Timings include HTTP and JSON decoding.
The database cache stays warm. The first request is not a cold database benchmark.
The isolated VM has two CPUs and 4 GiB of memory.
The earlier baseline uses 239,520 stats, ten managers, 700 lineups, and different compute.
These results establish local query latency. They do not establish hosted latency, browser speed, or a league capacity ceiling.

Run `scripts/bench/server-queries.mjs` only against an isolated local database.
Supply the output directory and the prior refresh function source as arguments.
It creates owned fixtures and removes them after measurement. It requires an unused current-season calendar.

## Local authenticated reads

| Read | Returned rows | Median, ms | p95, ms |
| --- | ---: | ---: | ---: |
| search-50 | 50 | 31.86 | 35.13 |
| search-name | 50 | 30.08 | 31.07 |
| player-detail | 1 | 2.11 | 2.63 |
| player-game-log | 7 | 1.72 | 2.02 |
| projection-player | 1 | 6.19 | 6.57 |
| projection-600 | 600 | 38.61 | 45.12 |
| dynasty-inputs-600 | 600 | 44.05 | 50.09 |
| averages-season | 600 | 5.00 | 6.12 |

All measured reads meet the 500 ms investigation threshold. No speculative query rewrite follows from historic maximum timings.
Projection and dynasty requests retain their bounded SQL limits and existing authorization checks.

## Cache refresh cost

| Leagues | Distinct scoring rules | Cached rows | Full refresh, ms |
| ---: | ---: | ---: | ---: |
| 3 | 1 | 10,440 | 794 |
| 30 | 1 | 104,400 | 1,400 |
| 30 | 11 | 104,400 | 4,448 |

The view expands each player's available seasons across leagues. Scoring-rule diversity adds computation without changing row cardinality.
These timings include two local SQL client launches. They are single full-refresh observations, not percentile estimates.
Allocated relation sizes include prior benchmark churn. They must not become per-league storage forecasts.

The old unchanged-refresh check scans 240,360 stats and touches 5,115 buffers.
The source-revision check reads one row and touches one buffer.
Eleven old checks take 16.6–18.6 ms. The new checks take 0.009–0.448 ms, including the first call.
Source changes, scoring changes, game eligibility changes, and deletes invalidate the revision.
No-row writes and unchanged game metadata leave it unchanged. Rolled-back writes do not advance it.
A transactional revision prevents an uncommitted write from being marked refreshed.
An advisory lock prevents overlapping full refreshes.
The revision row serializes source invalidations within their write transactions; keep ingestion transactions short.

## Hosted counters and growth

The database occupies 191,802,515 bytes at 16:48 UTC. Player stats occupy 92,643,328 bytes, including 46,055,424 index bytes.
These values do not disclose the project's storage allocation or billing tier.

| Season | Stat rows | Sum of row bytes |
| ---: | ---: | ---: |
| 2021 | 32,083 | 5,682,868 |
| 2022 | 38,158 | 6,753,808 |
| 2023 | 38,438 | 6,805,256 |
| 2024 | 41,086 | 7,264,984 |
| 2025 | 41,963 | 7,420,444 |
| 2026 | 43,188 | 7,640,688 |

Row-byte sums exclude indexes, page slack, and other tables. They are not storage growth forecasts.
Each complete synthetic season contains 39,360 rows and 6,455,040 row bytes.
No measurement supports partitioning or removing history at the observed scale.

Database temporary bytes total 1,269,404,049,146; their reset timestamp is unknown.
The counter increases by 89,543,736 bytes and eighteen files over twelve minutes, forty-nine seconds.
This proves new temporary-file activity. It does not identify its query source.
Statement statistics reset on May 14, 2026. They cover 24,766,242 calls and 301,511 temporary blocks written.
Historic statement maxima and cumulative database counters cannot describe current request latency.
Collect matched interval deltas before attributing spills or changing memory settings.

## Index and maintenance decisions

Keep both stats indexes. One indexes `(player_id, season_year, game_date DESC)`; the other indexes `(game_date, player_id)`.
Authenticated plans use the first for player logs and the second for date-plus-player lookup.
Neither index belongs to a constraint. Different column order serves different reads.
Keep narrower lineup indexes until plans prove redundancy. Zero scans since a reset do not prove uselessness.
No index is removed by this change.

The advisory query flags thirty-seven foreign keys without an unconditional leading index.
Several already have usable partial indexes, including dynasty players and trade-item players, picks, and members.
Membership authorization already has `(user_id, league_id)` and `(league_id, user_id)` indexes.
Taxi reads use league-prefixed primary keys. Explicit member and outsider checks preserve access boundaries.
Most remaining gameplay tables are empty in the hosted snapshot. No measured hot plan justifies additional indexes now.
Review parent-deletion and member-removal latency when those tables grow. Preserve every constraint.

Estimated dead tuples are 13,827 for player stats and 1,590 for games.
Dead-tuple estimates do not measure reclaimable file space or justify a table rewrite.
No production vacuum, reindex, delete, or retention reduction occurs during this work.
The daily response maintenance schedule retains ordinary vacuum; local tests prove expired-page reuse and live-response preservation.

## Scheduler decisions

The trade gate retains its five-minute schedule. It starts the worker only for due trades, notifications, or receipts.
The reconciler retains five minutes. Its hosted mean runtime is 93.3 ms across 2,016 weekly runs.
That is about 26.9 database execution seconds per day, before future gating savings.
Reducing its frequency would delay failure detection and claim recovery.

Nomination, stats, live, and lineup gates remain separate. Their observed mean runtimes sum to about 166 ms per coincident tick.
This sum does not measure connection setup or prove a shared connection bottleneck.
Combining them would couple failures without a demonstrated latency benefit.
Cron logging remains enabled. Its controls require a server restart, and the installed job catalog has no per-job logging switch.
Successful operational retention limits log growth without suppressing failures.

Response maintenance falls from twenty-four daily executions to one.
The hosted snapshot has seventy-three live responses, zero estimated dead rows, and a 327,680-byte relation.
The previous weekly sample has 168 successful maintenance runs averaging 119 ms.
The supervisor verifies size and reconciliation latency after release, especially because local and hosted pg_net versions differ.

## Investigation thresholds and owners

These are engineering triggers, not platform quotas or promises.

| Signal | Investigation trigger | Owner and action |
| --- | --- | --- |
| Hot reads | Repeatable p95 above 500 ms | Server owner captures authenticated plans and checks payload size and RLS costs. |
| Live scores | Repeated ingestion gaps above 24 seconds during healthy provider responses | Server owner measures query, provider, lease, and CPU time against the twenty-second cadence. |
| Trade delivery | Due work remains beyond the next five-minute dispatch plus worker runtime | Server owner checks gate predicates, claims, receipts, and dead letters. |
| Worker failure | No start or finish after ten minutes, still unreconciled after the next five-minute tick | Server owner checks durable outcomes and dispatch recovery. |
| Cache refresh | Repeated refreshes exceed ten seconds or overlap their next scheduled start | Database owner compares rule diversity, cardinality, plans, and lock waits. |
| Connections | Sustained use exceeds 48 of the observed 60 connections | Database owner checks pool use and competing jobs; confirms current allocation before resizing. |
| Storage | Weekly growth leaves less than ninety days against confirmed allocated capacity | Project owner confirms the dashboard allocation; database owner measures table and index growth. |
| Temporary files | Positive interval deltas coincide with slow requests | Database owner matches statement deltas and plans before changing memory. |
| External alerts | A destination or delivery credential is absent | Project owner selects and authorizes the destination and integration. |

## Runtime limits

Official Edge limits list 256 MB memory, two CPU seconds per request, and 150-second free or 400-second paid worker lifetimes.
Asynchronous waiting does not count as CPU time. Request idle timeout is 150 seconds.
The 110-second live worker and 115-second abort guard fit both wall-time limits.
Local Deno tests do not prove hosted CPU compliance; hosted CPU measurement remains a release observation.
No billing tier follows from database settings.
[Official Edge limits](https://supabase.com/docs/guides/functions/limits).

Cron recommends at most eight concurrent jobs and ten minutes per job. These are recommendations, not hard limits.
The hosted `cron.max_running_jobs` setting is 32. It does not establish available resources or safe concurrency.
[Official Cron guidance](https://supabase.com/docs/guides/cron).
