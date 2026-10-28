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
