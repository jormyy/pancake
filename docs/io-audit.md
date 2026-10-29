# Release 2.4 disk IO audit

This audit uses repository code only for workload estimates.
It makes no production connection.
The reported stall on 2026-10-28 does not establish a cause.
The supplied 106,518 cron rows over three days equal 24.66 inserted rows per minute.
That observation describes an earlier schedule.
The final schema has one work dispatcher and two direct SQL maintenance jobs.

## Units and assumptions

A write means an inserted, updated, or deleted row version.
A changed row can produce several writes through triggers.
Counts include logical writes, not just new live rows.
Bytes estimate row data and index entries before WAL, page images, compression, and free-space reuse.
They do not measure device traffic or hosted latency.
PostgreSQL uses 8 KiB pages.
An update can also dirty visibility maps, free-space maps, and index pages.
Conflicting inserts and row locks can produce WAL even when no row version changes.
The no-write tests count row changes, not zero disk traffic.

| Symbol | Meaning |
| --- | --- |
| `G` | Games that need live ingestion |
| `t` | Live ticks per minute: 3, from the 20-second tick |
| `c` | Changed player lines per game per tick; example: 10 of 36 |
| `S` | SQL work items completed per minute |
| `E` | Edge work items completed per minute |
| `H` | Lease renewals per Edge item; depends on duration and explicit renewals |
| `F` | Seasons whose screen results refresh per minute |
| `n, m, p, q` | Members, matchups, player averages, and trade values in one refreshed season |
| `d` | Rows whose stored screen content actually changes |
| `A` | New request IDs per minute |
| `B` | Accepted performance samples per minute |
| `K` | Forecasts refreshed per minute |
| `X` | Distinct affected league/topic/scope groups per minute |

Idle means no due domain work, no pending hints, no client writes, and no expired cache.
Daily and hourly work still runs when due.
Game estimates assume healthy workers and no retries.
Multiply per-game rates by `G`; multiply league fan-out by affected leagues.

## Write paths

Byte ranges are estimates for each row version unless the cell states otherwise.
They are not measurements from the restored backup.

| Path and code | Idle rows/minute | During games or changes | Estimated bytes | Skip unchanged? |
| --- | ---: | --- | --- | --- |
| pg_cron run history; `20261104000100_work_queue.sql` and `20261115000100_io_idle_and_retention.sql` | Before: 1 run/minute. After: 3.017 runs/minute, including the hourly prune. About 2–3 row versions/run. | Same schedule; missed or failed runs add logs. The supplied older observation is 24.66 inserted logs/minute. | 0.25–1 KiB/log row; after about 1.5–9 KiB/minute in row versions. | No. Run history records successful empty checks too. |
| Dispatcher enqueue and claim; `enqueue_scheduled_work`, `work_enqueue`, `work_claim`, `dispatch_work` | Before: 3 hint work items/minute. After: 0 application rows. | SQL item: enqueue, claim, finish = 3 work versions. Edge item: enqueue, claim, invocation link, finish = `4+H`. Expired leases add recovery writes. | 0.4–1 KiB/work version; payload can increase this. | Yes after reduction. Existing keys also skip sequence consumption. Due claims and lease recovery still write. |
| Work outcomes; `work_finish`, `work_capture_outcome`, `log_league_activity` | Before: 3 empty-hint success events/minute. After: 0. | One event per terminal work outcome or real product transition. Retries below the terminal attempt do not add a terminal work event. | 0.3–4 KiB/event; some details contain full source rows. | Existing status guards skip repeated product outcomes. Distinct business events stay separate. |
| Edge invocation and sync logs; `invoke_edge_function`, `start_edge_invocation`, `finish_edge_invocation`, `reconcile_edge_invocations`, `_shared/syncRuns.ts` | Before: 1 delayed hint invocation/minute. After: 0 outside due work. | About `4E` invocation versions, `2E` sync-run versions, plus failure handling. Reconciliation checks every five minutes when unresolved work exists. | 0.3–1.5 KiB/invocation version; 0.3–4 KiB/sync version. | Existing reconciliation compares response fields. Start, finish, and health evidence remain writes. |
| Work lease renewal; `renew_work_lease`, `_shared/syncRuns.ts`, `_shared/workContext.ts` | 0 after removing the idle Edge hint worker. | `H*E` work updates. Generic heartbeat runs every 30 seconds. Explicit phase renewals add writes. Live-poll also renews its ingestion lease every 30 seconds. | 0.4–1 KiB/work update; about 0.15–0.4 KiB/ingestion lease. | No for an active renewal. Fresh expiry protects ownership. |
| pg-net; `invoke_edge_function`, `retain_pg_net_responses`, `dispatcher/postgres.ts` | Before: one HTTP exchange/minute for delayed hints. After: no hint HTTP exchange. Hourly vacuum work remains due. | About `2E` request queue versions and `2E` response versions including later deletion. Responses keep six hours. | Request 0.5–2 KiB; response 0.2–4 KiB or actual body size. These extension tables are unlogged. | No for a real exchange. Existing response retention skips unreconciled invocation responses. Vacuum remains hourly. |
| Screen queue; `refresh_queue_screen_views`, `enqueue_screen_views`, `view_refresh_work` | 0 after discovery settles. | Up to one dirty mark, claim, and completion per season generation. A change during a claim adds a new generation. Any league change can dirty historical seasons too. | 0.25–0.6 KiB/version. | Existing dirty/version guards coalesce unclaimed work. Claims and completion remain necessary. |
| Stored screen content; `refresh_standings`, `refresh_matchup_totals`, `refresh_player_averages`, `refresh_trade_values` | 0 when clean. Before: unchanged refresh rewrites `F*(n+m+p+q)` rows. After: `F*d`. | Example: 12 members, 132 matchups, 600 player rows, 20 trades = 764 cache writes per refresh before. After, only changed content writes. The queue currently processes one season per Edge invocation. | Standings 0.2–0.5 KiB; totals 0.2–0.4 KiB; averages 0.7–2 KiB; trade JSON 2–64 KiB. Example old refresh: about 0.5–2.6 MiB. | Yes after reduction. Hash comparison also checks exact content, so collisions cannot hide a change. Stale workers still fail the queue version fence. |
| Trade publication metadata; `private.trade_value_publications`, `refresh_trade_values`, `view_context`, `view_trade_details` | 0 when clean. | One small metadata update per trade per newer published generation. This replaces a version-only rewrite of its analysis JSON. | About 0.1–0.25 KiB/publication version. | Yes for the same generation. A newer generation must record freshness, even when analysis stays equal. Changed timestamps inside the analysis still count as changed content. |
| League hints; AFTER STATEMENT `emit_league_change` on lineups, rosters, matchups, games, and player stats | 0. | Before: one hint update per league/topic per changed statement. After: at most one revision increment per transaction/topic; only wider scopes require another update. Bound scope lists to 16. Roughly `X` rows, with league fan-out. | 0.2–2 KiB/hint version. | Existing comparison ignores `updated_at`, `set_at`, and game progress fences. New transaction coalescing skips covered scopes. A later transaction still advances the revision. |
| Player and inventory hint queues; `emit_player_stats_hint`, `publish_league_inventory_hint`, `flush_player_stats_hints`, `flush_league_inventory_hints` | After: 0 application rows; the small SQL poll runs every 30 seconds. | Player hints insert at most one pending row per league. Draining writes a hint and deletes pending rows. Inventory normally publishes directly; contention appends pending rows. | Pending 0.1–1 KiB; published hint 0.2–2 KiB. | Empty drains skip all application writes. Player score hints retain their existing one-minute throttle. Inventory keeps the half-minute wake. |
| League publication versions; `league_version_capture`, `league_version_enqueue`, `league_version_flush` | 0. | One pending insert, optional topic/source expansions, pending delete, league version update, change insert, and version hint update per affected league transaction. The 128-entry window can delete one old change. | Pending 0.15–0.5 KiB; version/change/hint total about 0.6–3 KiB per league transaction. | Existing capture ignores equal data and cache publication fields. New enqueue guard skips a repeated topic/source pair. Actual committed changes still publish. |
| Score input revisions; row trigger `track_score_input_revision`, `bump_score_input_revisions` | 0. | Player stats can bump the same NBA week scope once per changed row: `t*G*c`, not once per statement. Other scopes include calendar, player, league, season, lineup, and result. | 0.1–0.25 KiB/revision update. Example `G=10,c=10`: 300 updates/minute, about 30–75 KiB. | Existing field comparison skips unchanged scoring inputs. It ignores freshness-only changes after stats first become available. No revision batching change in this audit. |
| Live player lines; `live-poll/runner.ts`, `_shared/syncStats.ts`, `save_game_stats_atomic` | 0 outside active or final rechecks. | `t*G*c`. At 10/36 changed lines and 10 games: 300 versions/minute, not 1,080. Each changed line also updates season aggregates and can trigger league revisions. | 0.25–0.6 KiB/stat version before aggregate and trigger fan-out. Example 75–180 KiB/minute. | Already compares all stored stat fields with `IS DISTINCT FROM`. Verified rather than reimplemented. Final sync still stamps `stats_synced_at` for its 30-minute recheck policy. |
| Team score and progress; `live-poll/scoreboard.ts`, `save_live_scoreboard_atomic`, `save_live_game_stats_atomic` | 0. | Up to `t*G` scoreboard writes plus `t*G` stat progress fences. Example: at most 60 game row versions/minute for 10 games. | 0.2–0.5 KiB/version; example 12–30 KiB/minute. | Client already skips equal score/status/text. New SQL guards skip exact repeats, including equal progress. Advancing progress still writes to reject older snapshots. Same-clock corrections still write. |
| Live aggregate tables; `private.maintain_player_season_totals`, `private.clear_player_season_totals` | 0. | The statement trigger combines old and new contributions before saving one delta per player/year. Budget about one aggregate update per changed line, plus team-history work when identity changes. | About 0.5–1.5 KiB/aggregate version; example 300 changed lines can add 300 aggregate updates/minute. | Unchanged lines never reach the row trigger. Do not remove real aggregate updates. |
| Certified scoring; `_shared/syncScores.ts`, score certificates, matchup updates | 0 when certificates match and no scoring is due. | Changed matchups, standings, and certificates add rows per affected league/week. Model as `scored leagues * affected matchups`, plus revision and hint fan-out above. | Matchup/standing about 0.3–1 KiB; certificates depend on input-token size. | Existing score comparisons and certificates skip settled results. Live ingestion still calls scoring each tick when due. |
| Matchup forecasts; `enqueue_matchup_forecasts`, `queue_matchup_forecasts`, `claim_matchup_forecasts`, `complete_matchup_forecast`, `matchup-forecast/index.ts` | 0 while clean and unexpired. | About 4 queue/cache versions per refreshed matchup: dirty mark, claim, forecast save, completion. `K` can approach dirty current/next-14-day matchups per tick. Expiry is six hours or the next tipoff. Queue triggers can rewrite an already dirty row. | Queue 0.2–0.5 KiB; forecast JSON 2–32 KiB; about `K*(2.6–33.5 KiB)`. | Claim requires dirty/expired work. Completion validates revision and token, but replaces JSON on each valid recomputation. The integrated forecast changes bound histories and prepare reusable inputs. Full forecast JSON still publishes after a valid recomputation. |
| Request replay receipts; `private.claim_request`, `private.request_finish`, `20261103000100_request_receipts.sql` | 0 without requests. | One receipt insert per successful new request ID: `A`. The result JSON can dominate bytes. Duplicate IDs read the saved result. | 0.2–16 KiB typical; use actual response length for larger results. | Existing actor/function/input-hash checks prevent replay writes. New IDs represent new operations, even if their visible result matches. Seven-day retention remains. |
| Performance beacons; `lib/perf-beacon.ts`, `functions/api/beacons/index.ts` | 0 without a completed sampled screen. | `B` inserted rows, up to 20 per request. The client sends at most once per minute, samples high volume, and drops empty/offline work. | 0.2–0.4 KiB/sample plus two indexes; `B=20` is about 4–8 KiB/minute. | Already batched in one INSERT. Repeated paint callbacks skip the sample. Distinct equal samples stay valid observations. Thirty-day retention remains. |
| Retention deletes; `run_retention` and `retain_*` | Daily work can delete due rows. Empty workers delete 0 rows but update one `retention_status` row per checked relation. | Same age policy during games. Workers generally cap 5,000 rows; sessions cap 500; projection cleanup also bounds parent scans. Dispatcher gives the loop two seconds. Failed/locked relations record errors. | Deleted tuple and index sizes vary. Status about 0.2–0.5 KiB/relation/day. Deletion frees reusable space after vacuum; it does not shrink files. | Deletes skip ineligible rows and locked victims. Status timestamps intentionally remain writes. |
| Other scheduled domain work; `enqueue_scheduled_work`, `enqueue_daily`, provider sync functions | 0 outside their due windows, except due health/maintenance work. | Players daily after 06:00 ET; schedule after 06:05; waivers at each league midnight; injury checks every 15 minutes near games or hourly otherwise; trade values daily after 07:15 ET, then pick predictions and versioned trade re-analysis; projections by policy; corrections after 06:20; draft order seasonally; cleanup at 08:35 UTC; room expiry at 09:30 UTC; retention after 10:00 UTC. Each adds the work/Edge overhead above plus rows actually imported or changed. | Use imported row count times row size; player/projection batches can dominate a quiet minute. These schedules do not imply a fixed production row rate. | Gate and provider-specific behavior vary. Provider freshness still follows its own gates. |
| Per-change product writes; receipt-wrapped API functions, roster/lineup/trade/draft/notification producers | 0 without actions. | Count base product rows, outbox rows, timeline outcomes, revisions, and league publication writes separately. One request can touch several members and seasons. | Base rows roughly 0.2–4 KiB; notification payloads and saved analysis can be larger. | Existing idempotency and transition guards vary by operation. Actual user actions and notification evidence remain writes. |
| Autovacuum and page reuse; hot-table storage settings in `20261115000100_io_idle_and_retention.sql` | No new application row versions from vacuum. | Dead tuples come from every update/delete above. Before, default vacuum threshold is about `50+0.2*live_rows`. New table hints use `50+0.02*live_rows`, with analyze at `50+0.05*live_rows`. | Page reads/writes depend on dead pages and free space, not just live row count. A 1,000-row hot table reaches the vacuum threshold near 70 dead rows instead of 250. | Vacuum visits dirty/dead pages. Fillfactor 90 reserves update space for future pages. It does not rewrite existing tables or guarantee HOT updates on indexed fields. |

## Safe reductions

| Migration | Change | Unchanged-input proof |
| --- | --- | --- |
| `20261115000100_io_idle_and_retention.sql` | Keep cron history for 24 hours, with 5,000 victims per hourly run. Preserve active executions. Remove three periodic hint work items and the delayed Edge call. Use direct SQL every 30 seconds. Gate reconciliation. Skip completed enqueue keys before consuming the sequence. Skip empty claims. Add vacuum/fillfactor hints to owned hot tables. | `tests/db/io-write-reductions.sql`: empty scheduling, sequence replay, empty drains, empty dispatcher, cron boundaries, repeated pruning, and storage settings. |
| `20261115000200_io_screen_content.sql` | Compare content hashes and exact values before cache updates. Preserve unchanged averages during pruning. Separate trade publication version/expiry from its JSON. Read freshness through the existing authorized context function. Cascade publication deletion from its cache. | Same fixture refreshes all four caches at a newer generation. Zero content rows change. One small trade publication row advances. Replaying that generation writes nothing. A changed team name updates one row. |
| `20261115000300_io_coalesce_changes.sql` | Coalesce covered league hint scopes within one transaction. Skip repeated publication topic/source pairs. Preserve new scopes and later transactions. | Repeated scope and topic/source checks observe no hint or pending-row update. |
| `20261115000400_io_live_progress.sql` | Skip identical SQL score/progress writes. Keep monotonic fences and same-clock corrections. | Duplicate live snapshot writes zero rows or score revisions. Changed stats and scores each write one row. Advancing progress retains its fence. |
| Existing behavior, no migration | Keep beacon batching and changed-line stat upserts. Keep HTTP response and invocation retention. | Beacon tests cover batching, repeated paints, and no further sends. Live fixture covers changed lines. Retention regressions cover preserved responses and repeated cleanup. |

The IO migrations add no dependency.
The final merge also changes live scoreboard handling and forecast workers.
Forecast input preparation and bounded history now run before context reads.
Extension-owned cron and net tables do not receive storage settings because the migration role does not own them.
Their existing pruning and explicit pg-net vacuum remain available.

## Retention and remaining pressure

Cron history previously kept successful runs for seven days and failed runs for thirty days.
The new hourly cap can remove 120,000 rows daily, above the supplied 35,506 daily arrivals.
A large existing backlog can take several runs to clear.
The normal 24-hour window can contain up to one extra scheduling interval of history.

HTTP response retention already keeps six hours and preserves responses needed for reconciliation.
Invocation retention already keeps successes seven days and failures thirty days.
It retains each function's newest outcome and closes abandoned work after thirty days.
Adding another delete path would duplicate that policy.

The small SQL poll adds about four to six cron row versions per minute.
It replaces roughly 25–28 application and transport row versions per idle minute from the three hint jobs.
That estimate includes lease renewals and later HTTP cleanup.
The benefit is smaller when hint work actually exists.

Hot stat rows still fan out into aggregate updates, score revisions, hints, and forecast work.
An example of 300 changed stat lines can cause about 900 stat, aggregate, and revision versions before league fan-out.
This explains why counting only inserted stat rows understates IO.
It does not prove the reported production stall's cause.

Time fences, replay receipts, real outcomes, and freshness stamps protect correctness.
They remain when freshness or ownership changes without a visible score change.
Forecast JSON publication and per-row score revisions still produce writes for valid changed inputs.
Precomputed forecast inputs reduce repeated history work.
They do not remove correctness revisions or promise zero disk traffic.

## Verification evidence

These are recorded implementation and integration results.
They are not new database measurements from this documentation session.
Rows marked final integration come from [the integration record](release-2.4-integration.md).
Other rows describe the earlier IO implementation checks.

Verification uses the private mini stack and the supplied schema/data backup.
The restore needs six local Storage compatibility columns and the repository's Auth signup trigger.
No restored credentials or user records appear in the evidence.
Schedules stay disabled during fixture execution.
The stack uses loopback bindings and port block 589xx.
A fresh migration reset then isolates regression fixtures from restored product data.

| Check | Result |
| --- | --- |
| Fresh migrations and attestations | Final integration: 608 migrations through `20261116000500`; all four generated artifacts match the incremental upgrade. |
| IO behavior fixture | 31 assertions pass, including scope widening and the operator pause. |
| Negative controls | Final integration: all 13 controls detect the old behavior. Original cache refresh writes five unchanged rows; current refresh writes zero. |
| Focused database regressions | Live ordering, work lifecycle, screen queue, retention queue, daily retention, and screen parity pass on fresh fixtures. |
| App Vitest on Node 22 | Final integration: 3,960 passed; 0 failed; 38 skipped. |
| Core Vitest on Node 22 | 118 passed; 0 failed. |
| Edge tests on the mini | 492 passed; 0 failed; 14 ignored. |
| Quality on Node 22 | Pass: lint, type checks, generated sources, inventory, dead-code checks, and design checks. |
| Database type and function parity | Both checks pass against the private migrated stack. |
| Season script tests | 312 passed; 0 failed. Tests require each half-minute drain and merge coincident worker wakes. |

The existing retention fixture used the earlier 10,000/20,000-row limits.
It now proves the current 5,000-row limits with 5,003-row fixtures.
The full application test run first catches an outdated release migration head.
The release database note includes all four IO migrations and the later forecast, identity, and trade migrations.

The replay tests preserve all minute dispatcher gates and cover the added half-minute drain.
No production performance or stall cause is verified.

## Database excellence audit, October 28, 2026

The supplied backup is restored into 59 tables at the current 608-migration schema.
The database measures 168,668,307 bytes before the screen workload.
Player statistics use 113,082,368 bytes, including 59,850,752 index bytes.
The source inventory finds 626 write sites and 277 SQL star sites across 486 function sources.
These lexical counts identify review work; they do not prove redundant writes.

The assigned database is replaced between the baseline and the screen walk.
Its new server starts at 07:20:24 UTC with 609 migrations and empty application tables.
The audit stops database work to protect that replacement instance.
The simulator target and migration attestation files also require changes outside the allowed paths.

No new indexes, partitions, write guards, or timeout migrations are claimed.
The [health report](db-health.md) records the measurements and each remaining delivery gate.
The [capacity worksheet](db-capacity.md) leaves the season projection blocked until the two-day workload runs.

## Exclusive-stack measurements

The audit resumes on `pt4bafabledb`, with database port `57422`.
The restore preserves 31 work kinds, 136 retention rules, and 44 notification kinds.
The screen walk records 50 successful calls before and after the first change.
All 50 result hashes remain identical.

Migration `20261119000100` skips unchanged lineup slot counts during an upsert.
The negative control fails before this migration and passes after it.

| Unchanged slot save | Before | After |
| --- | ---: | ---: |
| Rows written | 1 | 0 |
| Shared buffers | 30 | 7 |
| WAL bytes | 160 | 54 |
| Execution time | 0.821 ms | 0.267 ms |

The timing is one paired sample, not a latency service objective.
Four focused database assertions pass, including changed values and commissioner authorization.
The existing zero-slot and screen-parity recipes pass.
The source and attestation checks pass 627 tests.
The migration history is attested through `20261119000100` with 609 entries.

Migration `20261119000200` adds storage settings to seven remaining churn tables.
It sets fillfactor 90, vacuum scale factor 0.02, analyze scale factor 0.05, and row thresholds of 50.
The targets are sync runs, weekly lineups, the four screen aggregate tables, and player season totals.
The policy check fails before the migration and passes after it.
All 50 screen result hashes remain identical after this change.
The migration changes future page allocation and vacuum triggers; it does not rewrite existing pages.
No immediate disk-space or latency improvement is claimed for this policy.


## Complete screen inventory and simulation boundary

The expanded direct walk records 52 successful calls across all 26 stable screen functions.
Player search accounts for the two added calls.
The earlier 50 output hashes remain identical.
A temporary missing screen function makes the coverage check fail, then removal restores the passing result.

The two-day window covers October 29–30, 2026, and 13 games.
Its same-team historical mappings are explicitly synthetic.
The installed handler inventory fixes a reproduced missing-forecast response.
The profiled run stops before either day completes: player identities conflict, a provider input is unavailable, and a request times out.
A retry regression test rejects combined data and lock failures.
Cleanup preserves the original error if clock restoration also fails.
These simulator changes preserve production cadence and require every deferred work item to succeed.

The failed trace does not justify an index drop or a growth forecast.
The restored backup, native clock, expanded screen walk, slot checks, storage checks, and screen-parity recipe pass again.
The final focused Vitest run passes 629 tests with zero failures.
The focused simulator run passes 12 tests with zero failures.
The complete quality command and database function catalog pass.
The migration attestations cover 610 migrations through `20261119000200`.

## Identity lookup and missing Final reconciliation

Migration `20261119000300` applies the indexed identity lookup from the reviewed player-link fix.
The 500-player sample falls from 2,215.504 ms to 186.878 ms.
Its output hash remains `e57861bd9a141bb0257a02e6055ef95e`.
All 52 screen hashes match between the old and new lookup on the same restored data.
The one-second timing check and exact-identity collision checks pass.

Migration `20261119000400` binds six reviewed ESPN IDs to their existing NBA owners.
The archived ESPN and NBA box scores agree on each game and player name.
The evidence lists both provider IDs, game IDs, and source hashes in `tests/db/reviewed-player-provider-evidence.json`.
The migration refuses conflicting owners and preserves all player rows.
All six imports resolve without creating duplicate players afterward.
These identity repairs intentionally invalidate affected screen cache versions.

Migration `20261119000500` adds daily `missing-final-stats` work after 06:30 Eastern.
It finds Final regular-season games with no stat rows and uses the existing stats-sync queue.
Each transaction handles at most 16 dates and schedules an older-date continuation.
Pending repair jobs are reused; incomplete coverage does not become a permanent successful receipt.
Eight database checks cover scheduling, deduplication, dispatch, pending-job reuse, exclusion, and continuation.
The restored POR at LAL game is Scheduled, so the test changes it to Final and removes stats inside a rolled-back transaction.
The previous scheduler fails that test; the new scheduler passes.

The database workload now supplies a hashed, explicitly synthetic Sleeper identity response from the restored backup.
It uses only existing numeric provider IDs and leaves the archived replay modes unchanged.
No identity guard or workload assertion is disabled.

The first unlogged retry exposes 25 more historical name mismatches after the six repaired links pass.
The bounded database scenario now uses the backup's current ESPN and NBA roster identities as well as its Sleeper identities.
All three provider fixtures are hashed and labeled synthetic; the historical game events and workload assertions remain active.
Multiple lock-only failures may retry, but one non-lock error still fails the run.
The same bounded scenario reconstructs Sleeper responses from retained projection rows for the requested scoring week.
It preserves projected values, source game IDs, and modification times instead of returning unavailable responses for an existing backup dataset.


## Provider writes, terminal retention, and idle sessions

Migration `20261119000600` gates provider metadata and draft writes with `IS DISTINCT FROM`.
It retains the listing timestamps that prove source freshness.
The unchanged three-player replay writes zero player rows instead of three, with the same response contract.
Its paired samples take 18.703 ms and 16.856 ms.
All 52 screen hashes remain identical.

Migration `20261119000700` retains succeeded work for seven days and dead work for 90 days.
It preserves active work and deletes at most 5,000 expired rows per transaction.
The prior implementation fails the expired-dead-work check; the new implementation passes the boundary and batch checks.

Migration `20261119000800` bounds idle application transactions at 60 seconds.
An application-role connection initially survives an idle transaction with no limit.
After the migration, PostgreSQL terminates it with the expected idle-transaction error after 60 seconds.
Statement limits stay at three seconds for anonymous and worker requests, and eight seconds for interactive requests.
Lock limits are 500 milliseconds, with 250 milliseconds retained for workers.

The next two-day failure is calendar completeness, after identity and projection startup progress.
The restored calendar has 1,200 games and 80 appearances per team, with two long gaps.
The application classifies it as complete before rejecting those gaps.
The paired full-run measurements and season forecast remain blocked by that guard.

Migration `20261119000900` avoids rewriting unchanged schedule rows.
An identical 1,200-game publication now updates zero games instead of 1,200.
The paired samples take 344.836 ms before and 98.535 ms after.
Stored game values and all 52 screen hashes stay identical.
Five existing calendar cases still pass, including rescheduling, live markers, and rejection controls.


The database-window schedule now carries each restored game's recorded fantasy week.
The growth comparison records capture time separately and divides accelerated growth by the supplied simulated-day interval.
The retry checker accepts known source-link error wrappers only when their complete error is a database lock failure.
It still rejects combined identity and lock failures.

Migration `20261119001000` adds a BRIN index to the append-only event timestamp.
A rolled-back 100,000-event fixture returns the same ten rows before and after.
The range scan drops from 2,942 buffer hits and 4.458 ms to 37 hits and 0.124 ms.
The planner chooses the BRIN index without planner overrides.
All 52 screen hashes remain identical.
This is a synthetic growth test; the small restored event table does not show the same immediate benefit.

The replay now follows the production queue's bounded retry policy for failed requests.
It requires every deferred work item to finish successfully before acceptance.
Unowned failures, exhausted attempts, missing work items, and persistent data errors still fail the run.
This replaces the earlier message-specific retry classification, which stopped valid queue retries when error wrappers changed.


## Reliable plan capture and logging cost

The text-log parser previously skipped PostgreSQL's tab-indented plan records.
A reproduced negative check now passes, and malformed or incomplete records fail explicitly.
Concurrent stderr records can interleave inside JSON; they are retained as diagnostics, not complete plan evidence.
The private stack now uses structured JSON logging, and two concurrent sessions produce two independently parsed plans.
The single-session screen traces remain valid before/after evidence.

Three paired 500-player calls have identical result hashes.
Median execution time is 168.687 ms without nested logging and 602.308 ms with it.
The two full-workload attempts take 27.592 seconds without logging and 56.229 seconds with logging, but both fail during startup.
Their different failure points prevent a valid full-workload overhead ratio or season projection.

## Database replay after player-sync integration

The replay preserves the archived Sleeper identity outage as HTTP 503.
The merged worker defers that source without failing the other identity imports.
The previous synthetic success response forced unsupported birthdate profile lookups.
Those lookups exhausted the worker request budget.
The replay retains backup-derived ESPN and NBA identities and stored projection values.
It does not invent birthdates or skip worker dispatches.

The clock also stalls after pg_net times out a request whose worker still sleeps.
The observed worker waits 100 business milliseconds while all network calls are idle.
Its HTTP receipt has already left the pending set.
Clock advancement now counts that worker through the runtime health state.
Unstarted requests, active fetches, and awake workers still prevent advancement.
The final work-completion check stays mandatory.

The backup contains 400 five-year, 400 three-year, and 52 rookie ranking rows.
The database replay now reconstructs parser input from those stored rows.
All 852 rows retain their names, IDs, ranks, positions, comments, and numeric values through the real parser.
The reconstructed HTML is labelled synthetic and does not claim a fresh provider publication.
Other replay modes keep their original unavailable-source behavior.

## Monthly beacon and request-receipt partitions

Migration `20261119001300` partitions beacons by receipt month and request receipts by creation month.
Existing row values and all 52 screen outputs keep identical hashes on the restored backup.
A transaction first tests the complete conversion and rolls it back before application.
The migration also passes a repeat-application check.
Global identity guards reject concurrent duplicate IDs across months.
A negative control disables the guard and admits two copies of the same request ID.
Untrusted roles lack child access. The service role keeps read access; child writes require the parent.
New months include two months of headroom; the default partition accepts dates outside that range.
Maintenance moves default rows before it attaches their month.
Retention drops expired complete months and deletes at most 5000 rows from the boundary month.

A rolled-back 10000-receipt fixture measures the complete retention cycle.
Before: 16.501 ms, 21101 shared buffers, and 1300000 WAL bytes.
After: 4.264 ms, 1612 shared buffers, and 111780 WAL bytes.
These are single-run synthetic retention measurements with nested plan capture enabled.
The buffer and WAL reductions are measured. Repeat latency timing with statement logging off before using it for capacity.

The private replay reaches its first checkpoint after the calendar and identity fixes.
Checkpoint capture initially cannot find `pg_dump` on the supplied tool path.
The installed adjacent PostgreSQL client directory resolves that prerequisite without a new dependency.
A repeated data-only reset also exposes a dropped September receipt partition.
The private reset now recreates the saved monthly boundaries before restoring partition metadata and rows.
Its counter reset now precedes `ANALYZE`, so live-row estimates remain useful.

The replay next reaches its trade scenario and exposes a stale four-year pick assumption.
The current pick window has real future assets but no pick in that hardcoded fourth year.
The scenario now chooses the nearest available future asset owned by the recipient.
It still requires real ownership, excludes pending trades, and verifies both completed and deadline-blocked trades.

### Release merge and notification lookup

Release 2.5 is merged from `78c01b8c`.
The merge keeps dynamic Edge discovery and the existing player write gates.
The private database attests all 635 migrations after the notification fix.
The release scheduler supersedes the earlier missing-stat schedule entry.
A later corrective migration needs a date after November 23; approval is pending.

The unlogged replay fails while claiming notifications.
Each lineup reminder scans candidate lineups across every league.
Migration `20261119001400` limits that lookup to the reminder's league and member.
The global scanner uses the same candidate rules through a wrapper.
Malformed recipient IDs remain stale.

The repeated restored-data probe returns hash `046f0d264bbaf0b25d32876eac42fff7` before and after.
With statement logging off, execution falls from 2095.176 ms to 270.030 ms.
Shared-buffer hits fall from 2025577 to 204604.
The notification round-three, staleness, and bounded-claim checks pass.
The scoped candidate results also match the full scanner for every tested member and date.
The complete two-day replay still needs a passing receipt.

### League-midnight replay correction

The release changes waiver runs to midnight in each league's time zone.
The restored replay still expects 03:00 Eastern and fails on its first dropped-player hold.
The replay now calculates local midnight from the league zone, including midnight's own daylight-saving offset.
It preserves the 48-hour hold and the exact processing-time check.
The updated oracle fails two focused checks before the change and passes all six afterward.
The combined waiver and checkpoint unit run passes 22 checks.
The database's league-midnight and time-zone-change checks also pass.

### Partition-aware checkpoints

Checkpoints now save each child table's schema, owner, grants, constraints, and indexes.
Restore recreates a missing child before loading its rows and partition metadata.
It attaches each child after restoring its indexes because the parent already has indexes.
The native test rejects the original dump order and passes with the corrected order.
It verifies the restored row, indexes, row security, and service read grant.
Nine focused checkpoint unit checks pass.
Older checkpoints without child schemas fail before truncating data.

### Event and invocation partitions

Migration `20261119001500` partitions `edge_invocations` and `league_events` by month.
Restored row hashes match before and after: invocations `b143d2398791f5a59873aa7e9271c0e3`; events `d41d8cd98f00b204e9800998ecf8427e`.
The migration preserves grants, policies, triggers, foreign keys, and global invocation identifiers.
Repeated application, cross-month duplicate rejection, retention, and member-policy checks pass.
The full screen walk passes all 52 calls afterward.

Invocation retention keeps seven days of successes and thirty days of failures.
It preserves the newest success and failure for each function.
A month drops only when every row can expire; other months use bounded deletes.
League events retain two years, with complete expired months dropped and boundary deletes capped at 5000 rows.
Durable league activity and scoring tables retain their existing policies.

The isolated 10000-invocation retention probe keeps the same newest row before and after.
With statement logging off, execution falls from 57.635 ms to 21.512 ms.
Shared-buffer hits fall from 163192 to 3712; WAL falls from 1380062 to 27135 bytes.
These are fixture measurements, not season throughput.
The restored small-table retention probe rises from 27.069 ms to 32.775 ms because partition checks add fixed work.
The worker-bound check passes 42 assertions; league-midnight checks pass 43; time-zone rescheduling passes three.
All 636 migrations are attested, and the live function catalog passes.

### Partition index inventory

The index report combines child scans and storage under each parent index.
Its covering-index check compares operator classes, collation, sort options, and predicates.
The native catalog control finds the known lineup prefix pair.
Index removals remain pending the completed workload and before/after query plans.

### Public read retention and policy coverage

The public read path deletes every old counter row during one request.
Migration `20261119001600` caps request cleanup and the retention worker at 5000 rows.
A seven-day daily rule also prunes counters when public reads stop.
The complete drain preserves the same current counter row before and after.
The public API's 31 unit checks and the database public-CLI recipe pass.

The policy inventory now records the new bounded state and forecast tables.
Partition policy names always include their schemas.
The migration removes unused unqualified aliases and registers each current child, including default children.
The coverage check finds no unregistered public, private, or analytics relation.
All 637 migrations are attested.

### Trade publication statistics

A controlled startup capture identifies the next replay timeout.
The cached pick-value plan expects one ranking row after publication adds 450 rows.
It scans all 3870 season totals 450 times and takes 3022.694 ms for one nested call.
The complete RPC takes up to 5959.962 ms in this instrumented diagnostic.
The diagnostic uses a 30-second timeout and does not count as a passing simulation.

Migration `20261119001700` analyzes ranking statistics after a statement changes OneNumberHoops rows.
Other ranking sources skip that analysis.
The cached-plan reproduction takes 2740.850 ms before and 58.431 ms after, with logging off.
Both results hash to `e5224af33d56f052ca84624d0af46c6c`.
The stale-statistics assertion fails before and passes after the change.
All 638 migrations are attested and the live function catalog passes.
The next acceptance run restores the normal three-second worker limit and disables statement logging.

## Exact statement plan matching

Plan capture preserves PostgreSQL query identifiers as exact 64-bit values.
The old JSON parser rounds large identifiers and fails the new regression check.
The coverage report compares workload counter changes with captured plan identifiers.
It lists utility statements separately and leaves missing plans visible.
Captured plans still need review; plan presence alone does not complete the audit.
Verbose plan capture adds identifiers without changing the unlogged timing path.

## Stats and notification partitions

Migrations `20261125000100` and `20261125000200` preserve all recorded rows and all 52 screen results.
Sixteen before/after plans and thirteen SQL suites pass on the restored data.
Four native concurrency and checkpoint checks pass. Higher-isolation identity writes reject unsafe snapshots.

Stats partitions group up to 128 game IDs from one NBA season.
This preserves stale-season normalization and the existing player/game conflict key.
The bound avoids PostgreSQL's catalog row limit for a full season's UUID list.
All 24 existing triggers, both invoker-security views, and the appearance helper retain their definitions and permissions.
Physical rebalancing preserves aggregate totals and scoring revisions.
Daily maintenance refreshes membership and analyzes the parent. Historical stats remain durable.

The outbox uses monthly partitions and a bounded database enqueue path.
Its global IDs, dedupe keys, and ticket IDs remain unique.
Terminal messages expire after sixty days; pending messages prevent a partition drop.

| Probe | Before ms | After ms | Before buffers | After buffers |
| --- | ---: | ---: | ---: | ---: |
| Season/week stats count | 0.318 | 0.797 | 76 | 181 |
| Game stats | 0.037 | 0.143 | 7 | 9 |
| Player history | 0.030 | 1.115 | 12 | 342 |
| Outbox queue | 0.036 | 0.014 | 94 | 4 |
| Fresh batch of 100 notifications | 1.221 | 32.467 | 1016 | 6687 |
| Replay of that batch | 0.330 | 0.540 | 300 | 72 |

These are controlled single probes with plan logging disabled.
The fresh batch writes 70,366 WAL bytes, versus 58,254 before.
Partition routing and global identity checks add measurable cost. They do not establish a throughput gain.
The full workload still needs another run on this layout before index removal and final capacity acceptance.

## Rejected outbox partition and native-key correction

The outbox partition fails the measured-gain rule.
Its three global identity guards perform repeated partition probes for every inserted row.
Ten shuffled trials measure 38.530 ms with guards and 2.331 ms without guards for one hundred messages.
The native flat-table control takes 1.635 ms. Guard removal in this experiment is rolled back.

Migration `20261125000400` restores the flat table with native ID, dedupe, and ticket uniqueness.
It restores batched native SQL producers and simplifies the bounded rookie enqueue helper.
It preserves RLS, policies, ownership, grants, both original triggers, and every existing message.
Terminal retention returns to bounded deletion. Pending messages stay.
The table uses insert vacuum threshold fifty and scale factor 0.02.

The matched before/after insert takes 32.222/1.291 ms and 5788/1201 shared buffers.
The matched queue read takes 0.088/0.059 ms and 22/19 shared buffers.
Batch replay takes 0.670/0.322 ms with identical output.
The original pre-partition measurements are 1.221 ms per insert batch and 94 queue-read buffers.
The corrected insert is within 0.070 ms of that original single sample.
The corrected queue retains a seventy-five-buffer reduction without partition guards.
All measurements disable statement logging.

Seven SQL suites, two concurrent identity cases, and the isolation and bounded-claim checks pass.
The migration preserves fifty-two screen hashes and all rows, aggregate totals, and revision hashes.
The source check and live catalog pass. All 642 migrations are attested.
Evidence: turn7-partition-plans.json, turn7-partition-parity.json, turn7-screen-parity.json, and turn7-outbox-benchmark.json.
A separate corrected-layout two-day replay remains required before final acceptance.

## Plan-log review preparation

The optional compactor streams compressed backend logs and preserves the raw input.
It retains the highest buffer and time samples for each query identifier, plan shape, and predicate set.
Missing identifiers remain an explicit failure. This does not assert workload coverage.
A 100,000-record control reduces peak memory from about 563 MB to 72 MB.
Processing time rises from 0.91–0.92 seconds to 1.37–1.39 seconds, so the existing whole-file parser remains available.
Thirteen focused plan tests pass. Evidence: turn8-plan-memory.json.

### Replay HTTP receipt clock correction

The corrected-layout replay verifies both October 29 and October 30 game results.
It covers 13 games, 450 stat rows, and 4,154 live checks.
Final draining fails because 35 successful workers lose their HTTP response receipts.
The receipts use native time while cleanup uses the simulated clock.
A local HTTP probe reproduces immediate receipt loss before the fix.
Rebinding the response timestamp default produces a retained HTTP 200 receipt.
The simulator now rebinds and restores this default with application defaults.
The new regression check fails against the old clock and passes with the correction.
Twelve database clock checks and seven dispatcher/cleanup tests pass.
This change preserves HTTP failure checks and the production retention interval.
The complete two-day replay still requires a fresh run with this correction.

### Wake test repair

All five legacy wake tests pass on the corrected backup layout.
The old test first reproduces the missing `invoke_process_trades_if_due` error.
The tests now check scheduled `process-trades` work and duplicate suppression.
They retain notification claims, receipts, suppression, and trade-window checks.
The live-pick proposal fixture uses distinct assets to reach the intended guard.
The offseason fixture enters that phase before creating an accepted trade.
Nineteen queue cases and twelve trade-window checks pass.
Test writes roll back. No application behavior changes in this step.

### Release 2.6.1 integration

The release merge adds four upstream migrations without changing applied SQL.
Migration 20261125000500 preserves daily missing-final-stat reconciliation after ranking job removal.
It also registers the parent-scoped retention policy for trade estimate history.
All 647 migrations are attested and the live function catalog matches source.
Seven focused SQL suites pass, including reconciliation, scheduling, retention, and trade estimates.
Five focused Vitest files pass 51 tests.
The schedule fixture now uses fixed dates instead of assuming an empty production calendar.
The removed ranking scraper's parser test is removed with that worker.
The simulator still loads every remaining Edge function from the function inventory.
Generated types include partition tables and preserve both public and GraphQL schemas.

The scheduler control records 24.780 ms and 9,288 shared buffers before the correction.
Afterward it records 23.972 ms and 9,438 shared buffers.
These single samples show the intended extra reconciliation work, not a speed gain.
The scheduled reconciliation count changes from zero to one.
The remaining scheduler tests confirm ranking retirement and duplicate suppression.
The streaming reader also passes the end-to-end TypeScript configuration after a pipeline overload fix.

The merge passes 335 season tests and 61 focused Vitest tests.
Lint, all five TypeScript configurations, generated Core and Edge files, dead-code checks, source parity, surface coverage, and design checks pass.
The final full Vitest run remains pending until the remaining database audit changes are complete.

### Post-merge health baseline

The October 28 13:19:18.698 UTC sample records 238,677,139 database bytes, 206 table entries, and 927 indexes.
It records zero waiting sessions, zero idle transactions, and zero Final games without stats.
Stats occupy 142,983,168 bytes across the parent and leaves, with 245,097 estimated rows.
This follows verification work and is not a two-day growth sample.
The current source inventory lists 517 functions, 683 write candidates, and 294 SQL star candidates.
Those lexical counts identify work to review; they do not prove every path is covered.
The health and capacity documents now distinguish this sample from the earlier completed-layout forecast.

### Maintenance source review

The current 22 retention functions all declare three-second statement limits and 100-millisecond lock limits.
The health document records their age rules, batch limits, and preserved states.
Projection cleanup uses 500-row chunks within a shared 5,000-row budget.
Partition drops count rows before dropping; they do not have constant execution cost.
The legacy pruning entry point still needs a separate caller review.
The complete read/write and retention audit remains open.

### Completed corrected-clock replay

Both October 29–30 days and final worker draining pass on source d03b95cb.
The replay checks thirteen games, 450 stat rows, and 4,154 live samples.
The capture grows from 234,712,211 to 241,216,659 database bytes with logging off.
The health and capacity documents record the final baseline, resource sample, and numeric forecast.
All-statement plan coverage and the remaining audits are not implied by this replay pass.

### Completed replay plan coverage audit

The streaming reader consumes the completed timing log and finds zero plans in 64 records.
The counter comparison reports 1,644 missing non-utility plans and 37 utility statements.
This fails the full coverage gate; timing-off logs cannot prove plan coverage.
A new post-replay screen walk passes 52 calls and records 13,749 plans across 265 query texts.
Full statement review still needs a separate logged workload.
The timing snapshot lists 254 zero-scan nonunique index entries totaling 23,814,144 bytes.
Unused-index removals remain deferred until full coverage, child-index usage review, and paired measurements.
Live catalog, loopback generated types, and all 647 migration attestations pass again after replay.

### Round-end verification boundary

The full Vitest run records 4,214 passes, one release-order failure, and 39 skips.
The required release-note correction is outside the approved file scope and awaits permission.
The test is retained, with its failure reported.
Season tests, quality, live catalog, loopback types, and 647 migration attestations pass.
The private stack is stopped after preserving the successful two-day endpoint.
Full plan coverage, index removals, and the remaining read/write/timeout/retention audit are not complete.

### Release 2.6.2 integration

The merge adds migration `20261128000100` without changing earlier applied migrations.
The private stack applies and attests all 648 migrations.
The live catalog and regenerated loopback database types pass.
The release-order test now accepts the documented supplied production head.
Its missing-head control removes every repeated reference, so it still detects missing rollout evidence.
The release notes retain their existing order and identify the complete private migration head.
All 25 release-compatibility tests and 34 focused Edge tests pass.
The private contention check passes 21 overlaps at a five-millisecond lock limit with zero lock waits or timeouts.
Its local adaptation uses the assigned ports and permits existing injury cleanup only on its first round.
The underlying fixture remains unchanged; no other stack is contacted.

### Partition-aware index candidate query

The new read-only query aggregates parent and child index usage before comparing B-tree prefixes.
The private probe returns 23 candidate pairs and keeps scans visible for used candidates.
It checks sort options, collations, operator classes, included columns, and predicates.
It excludes constraint and replica-identity candidates.
No index removal or speed gain is claimed from this query.

### Read-path contract review

The health report now records six remaining reader families, page bounds, sort keys, and required cursor fields.
Dynasty page selection and output use different orders, which a cursor change must reconcile.
Projection cursors require explicit null and equal-score handling.
The activity union requires a source discriminator for equal IDs and timestamps.
Standings still recompute affected league-season aggregates; stored output alone does not prove incremental maintenance.
No pagination or aggregate-maintenance change is claimed in this review step.

### Anonymous plan preservation

The live capture exposes plans with empty query text and no query identifier.
PostgreSQL records their containing SQL function in the log context.
The original compactor merges different expressions that share a node shape.
A failing regression test demonstrates that loss.
The compactor now retains anonymous output expressions and their function contexts.
Missing identifiers still fail the identification check; this change does not claim complete coverage.
All fourteen focused parser, compactor, and coverage tests pass.

The anonymous-plan fix preserves two additional expression plans in the 270,587-plan startup sample.
The coverage audit also identifies `DEALLOCATE` as a utility command with no executor plan.
A failing-before test reproduces its incorrect missing-plan classification.
The corrected classification keeps it visible as utility work and leaves data queries subject to plan coverage.

### Current release verification

The full Vitest run now passes 4,217 tests with zero failures; 39 tests remain skipped.
All 335 season tests and the complete quality command pass.
The release-order failure is resolved without disabling its negative controls.
The merged database catalog, loopback types, and 648 migration attestations pass.
The instrumented replay is still in progress; these checks do not close its coverage gate.

### Health transaction-age correction

The live replay reproduces an invalid transaction age of 95,654 seconds in the health report.
The host-time check bounds that transaction at 11.5–11.7 seconds.
Transaction start times use real time, so subtracting the replay's business clock produces the wrong age.
The report now uses the server's real clock for this field.
A database regression check fails before the change and passes afterward.
Both expressions have retained `EXPLAIN (ANALYZE, BUFFERS)` records.
The change affects diagnostics only; the active replay retains its original operator source.

### Repeated lineup notification checks

The logged replay exposes a notification claim timeout before day-one tipoff.
A matched logging-off probe measures 3,181.390 ms and 394,375 buffers before batching.
Computing current candidates once per member and league gives 452.023 ms and 73,469 buffers.
The returned hashes match on the failed replay state.
A separate fixture checks 160 valid deliveries, 40 stale suppressions, and claim leases.
Its batching check fails against the old function.
Migration `20261125000600` preserves the 200-row claim bound and send-time admission check.

Three further generic-plan probes measure 426.838 ms with logging off and 2,507.498 ms with logging on.
The corresponding old-function medians are 2,942.561 ms and 18,909.782 ms.
The logged replay is incomplete; its plans do not close the two-day coverage gate.

The full queue-state hashes and all 52 screen hashes match before and after the claim fix.
Seven notification SQL suites pass.
The pause test now supplies its commissioner's identity to the existing authorization gate.


### Streaming coverage input

The coverage CLI no longer decompresses the complete backend log into memory.
It reads one JSON record at a time and retains exact identifier counts.
The 100,000-record control counts every plan in both implementations.
Resident memory falls from 422,199,296 to 61,767,680 bytes.
Sixteen parser, compactor, and coverage checks pass, including malformed-input rejection and missing-plan detection.
The running replay remains on its unchanged application source.


### Index removal probes during detached replay

Fourteen populated index candidates receive paired before/after plans in a separate restored database.
Every tested prefix read returns the same hash.
The lineup league/week removal increases read buffers from 95 to 97 and is rejected.
The season-only lineup removal saves WAL bytes but has no demonstrated latency gain.
No index is removed from the replay or shipped from these measurements.


### Repeated forecast invalidations

Migration `20261125000700` guards unchanged queue values within a transaction.
Three paired 100-call probes reduce writes from 100 to zero with identical queue rows.
Median execution falls from 8.068 to 5.839 ms and buffers from 2,131 to 1,301.
Measured WAL falls from 17,860 to 54 bytes.
Five new checks cover unchanged values, reactivation, new revisions, and retained leases.
Thirty-one existing forecast checks also pass on the separate restored database.
The active two-day replay remains on its original schema.


### Retention fixtures on restored data

The restored backlog exposes assumptions in three retention fixtures.
The corrected fixtures isolate expired rows, use distinct source names, and identify the current dispatcher.
The bulk beacon setup bypasses row triggers only while seeding its 12,000 test rows.
Normal triggers run during the retention checks.
Seven suites pass, including 70 daily checks and 46 worker-bound checks.
No production retention policy changes in this step.


### Roster member index removal

Ten paired 1,000-row probes reduce insert time from 13.665 to 12.290 ms without the redundant member-only index.
Measured buffers fall from 16,410 to 15,392 and WAL from 884,456 to 811,816 bytes.
The eleven-buffer prefix read and all 52 screen hashes remain unchanged.
Migration `20261125000800` keeps the existing composite access paths and removes 16,384 allocated bytes.
The fresh replay's completed usage counters still require review before applying this migration there.


### Rejected standings prototype

The incremental standings prototype preserves correction and deletion behavior in fourteen checks and one concurrency probe.
Its isolated reads improve, but the mixed early-season workload rises from 138.427 to 146.318 ms.
The finalized-history mixed workload improves from 144.086 to 135.434 ms.
The early-season regression prevents adoption. The prototype is reverted and remains private evidence only.


### Pending invocation partial index

Counting filtered-out rows exposes a scan of 5,889 completed invocations for an empty pending set.
Migration `20261125000900` replaces the old partial index with the complete pending predicate.
Idle reads fall from 195 to eleven buffers; populated reads fall from 169 to four.
The 100-row insert probe shows no latency regression, at 21.518 versus 20.534 ms.
Results match, and the new plan-budget test fails before the change.


The pending-index replacement preserves all 52 screen hashes and passes five invocation suites.
The correlation fixture now tests the work-queue lease path instead of removed cron-dispatch functions.

## Daily statistics refresh and memory review

Migration `20261201000100` adds fifteen daily ANALYZE tasks after off-peak retention.
The existing dispatcher serializes them and preserves the worker's time budget between tables.
Each task uses sixteen-MiB maintenance memory and a 100-millisecond lock setting.
All physical screen inputs use a 0.02 analyze scale factor and a 25-row threshold.
New stats partitions receive the same settings; daily analysis also refreshes the partitioned parent's statistics.

A controlled churn check updates 8,365 row versions without changing their values.
All 83 populated physical tables acquire a new automatic-analysis timestamp within 120.421 seconds.
The empty default stats partition remains excluded from that churn check.
The maintenance fixture passes 26 checks, and all 52 screen results remain identical.

A streaming review finds no spills in the preserved 3,500,386-plan partial capture.
Another 495 logging-off calls compare function-local work memory at four, eight, and sixteen MiB.
No higher setting removes a spill. No work-memory increase ships.
The detailed timings and the sixty-connection memory calculation appear in the health and capacity reports.

Release 2.6.3 restores the rankings scheduler and overwrites the earlier reconciliation schedule.
Migration `20261201000200` adds the missing daily reconciliation back without changing the three ranking tasks or other queued counts.
The failing-before scheduling test passes after correction.
The restored-data dynasty reader improves from 334.721 to 78.045 ms at p95 after the incoming speed migration.
All eighteen complete snapshot pairs remain equal.

Migration `20261201000300` reuses valid per-date forecast inputs before repeating the projection query.
The existing observation date, source revision, scoring hash, roster hash, and expiry define validity.
Five paired twenty-call probes fall from 285.600 to 4.772 ms and from 61,068 WAL bytes to zero.
Twenty unchanged cache updates become zero; every cached value remains identical.
Changed-source probes retain twenty required updates and measure 303.485 versus 304.514 ms.
The earlier compare-after-compute candidate regresses and is discarded.

Migration `20261201000400` indexes the recent score-dispatch cooldown check.
Five paired checks reduce empty-read buffers from 194 to three.
A controlled 150-check, ten-insert mix falls from 60.745 to 4.899 ms.
Its WAL rises from 3,129 to 3,760 bytes; the report retains that cost.
The separate hundred-score-insert probe rises from 21.263 to 21.740 ms.
The used reconciled-time index remains installed after recording 417 replay scans.

Migration `20261201000500` shares player-average inputs between the upsert and stale-row deletion.
Five paired fifty-refresh probes fall from 930.131 to 514.767 ms, with identical cached rows.
Buffers fall from 113,499 to 109,037; WAL remains 22,248 bytes.
The new seven-condition fixture covers insertion, correction, deletion, version rejection, and unchanged rows.
The older cache fixture now uses the current claim and retry contract; both function versions pass it.

### Database plan capture interval

Coverage now checks both database identity and the snapshot time interval.
A negative control confirms that the previous reader accepts a plan outside that interval.
The corrected reader rejects it. All 23 parser, compactor, and coverage tests pass.
The compressed-log summary streams records and retains slow and buffer-heavy plans separately.

### Player game pagination caller

The player hook accepts a game cursor and keeps each subsequent request at 15 rows.
It retains visible pages through loading and retries.
It clears those pages when the player, season, account, or data revision changes.
It preserves compatibility with the current first-page response.
Five focused files pass 56 tests. Application and test type checks pass.
The matching SQL candidate still requires backup parity and plan measurements before application.

### Preserved full-log measurements

The streamed primary log contains 3,498,732 plans, 1,653 query texts, 353 index names, and no spills.
The summary takes 52.91 seconds and 601.58 MiB peak resident memory on the Mac.
Review notes cover all 35 flagged statements in the retained high-cost samples.
Current interval coverage remains incomplete: 397 captured entries, 36 utilities, and 821 missing plans.
A fresh current-source logged workload remains required before unused-index removals.

### Write inventory precision

The write scanner excludes row locks, comments, and string literals.
The current source has 583 direct write statements and 70 conflict-update branches.
It separately reports 306 row-lock clauses and 22 functions with dynamic SQL.
Two negative controls fail against the earlier scanner. Ten focused tests pass.
The direct hint-drain cron phase still needs a bounded-timeout correction and a live contention test.

The final scanner also excludes nested dollar-quoted SQL literals.
Its corrected totals are 580 direct writes, 69 conflict branches, 304 row locks, and 275 SELECT-star sites.
All 22 functions with dynamic SQL remain explicit review candidates.

### Live statistics maintenance

The current 659-migration replay completes all 15 daily analysis jobs before its workload snapshot.
At 19:08:40 UTC, eleven tables have new automatic-analysis timestamps after workload start.
All 84 physical targets retain the configured analyze thresholds.
The raw timestamp evidence is separate from the unfinished two-day receipt.

### Hint-drain time limits

Migration `20261201000600` adds a three-second statement limit and a 250-millisecond lock limit to the half-minute hint drain.
The schedule and both pause guards remain unchanged.
A blocked-row test fails before this change and passes afterward.
The old command reaches the test's 1.5-second fallback; the new command returns a lock timeout in 271.7 ms.
Seven checks cover pause handling, retained hints, retry results, and statement cancellation.
Both unblocked plans retain identical revision and queue results.
The catalog, loopback types, and 660 migration attestations pass.

The write-count fixture now resolves each stats partition to its parent table.
It previously reports no parent-table correction because the row trigger reports the child name.
The corrected fixture and live-stat hint fixture both pass.
The cron reader also follows direct command updates so the replay uses the installed limits.

The separate balance-contention test still fails on a screen-refresh queue lock.
The hint-drain correction does not resolve that queue contention.

### Replay storage failure

The latest replay completes October 29, including three final games and their scoring checks.
October 30 stops at 23:37 because PostgreSQL cannot extend a data file.
Old PostgreSQL profiling logs occupy about 37.8 GiB when the private Docker disk fills.
These logs are archived, decompressed, and hash-checked before their originals are removed.
This failed run supplies no accepted two-day receipt or final capacity forecast.

### Balance hint contention

The unchanged balance-contention test passes all 25 checks after removing the duplicate screen-queue update from inventory hints.
The deferred version publication still invalidates the screen cache at commit.
A stale balance-only transaction retains its version publication for the existing hint drain.
Membership changes still abort on serialization conflicts.
Twelve added checks prove stale-read protection, single publication, rollback, and worker access limits.
All 52 backup screen hashes remain identical; the screen field fixture passes 63 checks.
Five paired 50-write probes improve from 24.525 to 20.805 ms.
Their median buffers fall from 4,867 to 4,752, and WAL falls from 42,879 to 39,456 bytes.
Migration `20261201000800` carries this change.
It is verified on the restored audit database while the separate two-day replay continues.

### Bounded diagnostic storage

Capture now supports rotated files, a 64 MiB retained-plan limit, and summaries that delete validated raw segments.
Logging begins at the measured workload and stops before clock restoration.
The private runner samples 10%, rotates at 10 MB or one minute, and requires 20 GiB free in the VM.
A real 48,202-plan segment reduces from 141,517,713 uncompressed bytes to 196,630 retained bytes.
The archive cleanup keeps per-file plans and checksums before deleting old captures.

### Draft-only publication

Migration `20261201000900` retains the six requested draft tables and removes the other 16 publication entries.
The internal Realtime messages publication remains unchanged.
Before-and-after catalog plans and six table hashes are recorded.
Logical decoding falls from three row messages to one, and from 3,743 to 1,368 bytes for the same probe.
The retained draft update appears once in both results.
The simulator now verifies the retained draft stream before the workload; existing game and scoring oracles still verify matchup data.

### Worker admission cap

Migration `20261201001000` lowers the global active-work limit and each native dispatcher pass from eight to four.
The unchanged queue payloads complete in two batches; no work is discarded.
Three paired eight-request probes keep eight database connections open in both variants.
Four concurrent authenticated reads reduce median peak anonymous resident memory from 275.4 to 240.2 MiB.
All result hashes match. The probe retains each result for 1.5 seconds to expose concurrent allocation.
A fresh whole-replay check remains required after applying this cap.

### Player game cursor

Migration `20261201001100` replaces repeated cumulative game reads with a date-and-ID cursor.
The 37-row tied-date fixture passes nine checks, including insertion stability and authenticated access.
Five paired six-page walks return the same 86 ordered rows.
Median time falls from 22.044 to 6.179 ms; buffers fall from 3,108 to 1,788.
Response bytes fall from 432,755 to 127,978.
All 52 other screen outputs remain identical.
The previously reserved, unapplied `20261201000700` candidate is superseded by this migration.

### Version regression fixture

The broader version-write fixture now runs queued trade publications before checking their versions.
It restores roster ownership between the trade and roster cases.
All 126 version-write checks pass; the original contention test remains unchanged.


### Final corrected-layout receipt

The logging-off replay on source `7ade191c` passes both October 29 and October 30 with all 667 migrations.
It verifies 13 games, 450 stat rows, 4,036 live checks, and the retained draft feed.
No Final game lacks stats. Statement counters and the server start remain unchanged.
The interval records 1,089,692 top-level statements, zero temporary writes, and zero sampled lock waits.
All 30 daily ANALYZE tasks succeed; 51 reported relations receive automatic analysis.

The final database allocation is 242,936,979 bytes.
The two-day allocation change projects 661,552,275 bytes at season end before separate WAL, backup, and maintenance space.
Peak database-container memory is 977.6 MiB; peak CPU is 2.1075 cores.
These figures describe the corrected replay, not a controlled comparison with the earlier overlapping audit.

Full Vitest passes 4,267 checks; the season and health suite passes 392 checks.
Both report zero failures. Quality, native three-season checks, catalog, loopback types, and 667 attestations pass.
Broader statement coverage, remaining write/read/retention reviews, and other pagination callers are deferred to the climb.
