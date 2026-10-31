# Trade input database contract

## Release 2.14.6

The supplied production head is `20261214005900`, with 741 migrations at main `7fdaf684` (release 2.14.5).
Release 2.14.6 adds one migration. The candidate contains 742 migrations through `20261214006000`.

| Migration | Change |
| --- | --- |
| `20261214006000_inactive_pickup_drops.sql` | Allows Taxi and IR drops in pickup claims and checks the selected slot at processing. |

Managers can select Active, Taxi, or IR drops. Eligible pickups can use the inactive slot that the drop frees.
Quick-add carries its drop and destination into the scheduled claim form.
A Taxi or IR drop does not free Active capacity.
A drop lost in a completed trade stays on its pending claim and fails with the existing invalid-drop result and notification.
Rejected processing rolls back roster, slot, add-count, and budget writes before recording the normal failed-claim outcome.
PA004 lock errors still propagate for Active-drop and no-drop claims, as on main.
No game state blocks or fails a claim with a Taxi or IR drop. Claims run at league midnight, so they take effect the next day.
Started lineup rows stay in place when the drop is released. Ownership, slot, and reservation checks remain.
A claim can drop the illegal Taxi or IR player it cures. Any other roster problem still blocks with PA003, PA005, or PA009.
The migration also redefines `create_waiver_claim_atomic`, `edit_waiver_claim_atomic`, and `prevent_pending_waiver_claim_with_ineligible_ir`. Their arguments and the private helpers do not change.

The frontend and SQL ship in one commit. Existing RPC arguments and the free-agent RPC surface remain unchanged.
The new frontend submits inactive drops through the existing claim RPC, which older SQL rejects before writing a claim.
Old frontends retain Active-drop placement and fallback behavior against the new SQL.
All pickups still require scheduled claims. Immediate adds remain blocked in every league state.
## Game-night performance

Each migration below ships alone. Apply them in order. The baseline is main `7fdaf684` with 741 migrations through `20261214005900`.

| Migration | Change | Deploy order |
| --- | --- | --- |
| `20261214006100_live_poll_stalled_retry.sql` | Retries a live-poll item on the next dispatcher minute when its worker never started or stopped renewing its lease. | Database only. |
| `20261214006200_skip_empty_statement_triggers.sql` | Stops three statement triggers before dynamic SQL when no row changed. | Database only. |

## Release 2.14.5

The supplied production head is `20261214005800`, with 740 migrations at main `9837c091` (release 2.14.4).
Release 2.14.5 adds one migration. The candidate contains 741 migrations through `20261214005900`.

| Migration | Change |
| --- | --- |
| `20261214005900_bounded_first_screens.sql` | Loads 20 mock rooms, with live rooms first, and 5 recent Home announcements. |

## Release 2.14.4

The supplied production head is `20261214005700`, with 739 migrations at main `d46d7e22` (release 2.14.3).
Release 2.14.4 adds one migration. The candidate contains 740 migrations through `20261214005800`.

| Migration | Change |
| --- | --- |
| `20261214005800_league_trade_history.sql` | Shows every member the league's accepted and completed trades in History. |

## Release 2.14.3

The supplied production head is `20261214005600`, with 738 migrations at main `391f639c` (release 2.14.2).
Release 2.14.3 adds one migration. The candidate contains 739 migrations through `20261214005700`.

| Migration | Change |
| --- | --- |
| `20261214005700_trade_curve_no_flat_roster_value.sql` | Removes the flat roster spot value and queues model v6 once. |

## Release 2.14.1

The supplied production head is `20261214005500`, with 737 migrations at main `be4a0ce8` (release 2.14).
Release 2.14.1 adds one migration. The candidate contains 738 migrations through `20261214005600`.

| Migration | Change |
| --- | --- |
| `20261214005600_perf_beacon_screens.sql` | Accepts `home`, `waivers` and `draft-setup` timing beacons. |

## Release 2.14

The supplied production head is `20261214005409`, with 729 migrations at main `c5789474` (release 2.13.1).
Release 2.14 adds eight migrations, including seven earlier-numbered versions. The candidate contains 737 migrations through `20261214005500`.
Apply missing migrations with the normal runner and `--include-all`, in this order:

| Migration | Change |
| --- | --- |
| `20261214004000_live_broadcast.sql` | Private Broadcast writers and receive authorization for all 16 watched tables. |
| `20261214004010_coalesce_live_hints.sql` | Compact transaction hint batches with a private unlogged queue. |
| `20261214004200_bound_cron_history_batches.sql` | Limit each hourly cron-history cleanup to 512 rows. |
| `20261214004300_start_work_invocation.sql` | Combine leased invocation startup with initial renewal. |
| `20261214004400_coalesce_invocation_reconciliation.sql` | Write each final invocation outcome once. |
| `20261214004500_batch_trade_refresh_checks.sql` | Fingerprint trades in a league batch and coalesce pending legacy work. |
| `20261214004600_gate_unchanged_trade_scans.sql` | Skip unchanged-source scans and coalesce work committed between applies. |
| `20261214005500_pre_tipoff_member_failures.sql` | Record terminal member failures and let healthy pre-tipoff members finish. |

Apply all eight migrations before the updated workers and Broadcast frontend.
Migration 04300 precedes workers using the shared invocation wrapper.
Migration 04600 precedes the `refresh-views` completion call's model field.
Migration 05500 precedes the updated `lineup-optimizer` failure-receipt call.
Older workers remain compatible while SQL is applied.
Keep main's 05406–05408 `private.work_claim` definition exactly. This package does not change claim order.

Both 04500 and 04600 replace pending checks and duplicate scans with one full scan per season.
The oldest scan keeps the earliest due time and loses its continuation cursor.
Superseded rows finish as succeeded with a `supersededBy` marker and retain prior attempts, errors and invocation links.
Closed or missing scopes finish without replacement work.
Running work, locked pending rows, existing revaluations and failed retries retain their worker path.
Repeated cleanup changes no rows. The upgrade proof is `tests/db/trade-revaluation-upgrade.sql`.

Migration 05500 adds nullable `lineup_tipoff_members.error` and service-only `record_pre_tipoff_lineup_failure`.
It reapplies the existing lineup slot guard from migration 025. Roster reservation guards stay unchanged.
Member errors receive durable receipts while healthy members finish and the work succeeds.
Dispatch reads, finish errors, lease loss and failed receipt writes remain retryable.
The older worker remains compatible with the additive schema.
[Pre-tipoff proof and reruns](../docs/pre-tipoff-trade-offer-fix.md) distinguish the historical guard from main's reproduced batch failure.

Committed Broadcast messages remain durable in `realtime.messages`. The private queue drains before commit.
Keep the 16-table `supabase_realtime` publication until all legacy clients reload and their subscriptions drain.
Publication retirement needs a separate migration and delivery check.
Restore the publication before rolling back to a legacy frontend.
The independent 20-second live-game fallback and reconnect reads stay active.
Home foreground recovery shares its version request and keeps the scheduled read and failed-validation retry.

Release `api`, `refresh-views`, `lineup-optimizer`, and the internal workers that consume `_shared/serve.ts` after SQL.
The shared invocation wrapper changes in `_shared/syncRuns.ts`.
Database, then Edge, then merge the frontend.
The orchestrator ships. This branch does not push or deploy.

Methods and reruns: [Realtime](../docs/perf-l1.md), [workers](../docs/perf-l4.md), and [Home recovery](../tests/e2e/pwa-live-game.md).
[Cleanup](../docs/release-2.14-cleanup.md) lists removed paths and retained coverage.
[Integration](../docs/release-2.14-integration.md) records the private upgrade/reset comparison and checks.

## Release 2.12

The supplied production head is `20261214003900`, with 711 migrations at main `952580ce`.
Release 2.12 adds eight migrations and ends at `20261214005302`, with 719 migrations.
Apply these migrations in version order:

| Migration | Change |
| --- | --- |
| `20261214004100_skip_fresh_screen_statistics.sql` | Skip fresh targets in the separate daily statistics job. |
| `20261214005000_trade_action_reservations.sql` | Share reservation reads within each trade legality check. |
| `20261214005001_trade_reanalysis_averages.sql` | Scope reanalysis averages to the existing league and season helper. |
| `20261214005100_roster_action_game_locks.sql` | Bound roster participation reads to the recent slate. |
| `20261214005200_lineup_fallback_stored_rows.sql` | Read stored lineup slots once per fallback candidate query. |
| `20261214005300_batched_dynasty_rankings.sql` | Batch dynasty ranking reads. |
| `20261214005301_delete_unarmed_timer_writes.sql` | Skip unarmed timer writes during deletion while retaining pick locks. |
| `20261214005302_shared_visible_games.sql` | Share the visible-player game selection. |

After SQL, deploy `process-waivers`, `lineup-optimizer`, and `sync-draft-order`.
These workers select fewer unused database fields. Final responses and ordering stay unchanged.
The API changes in this release are tests only and require no API deployment.
Trade rules, roster legality, permissions, game locks, scoring, timers, publications and queued work keep their existing behavior.
The statistics job retains its schedule and thresholds. Its diagnostic status and elapsed time reflect skipped sampling.

Methods and reruns: [trades](../tests/db/trades-actions.md), [roster](../tests/db/roster-actions.md),
[lineup and draft](../tests/db/lineup-draft-actions.md), [league](../tests/db/league-actions.md), and [background](../docs/perf-l4.md).
[Integration checks and repeat cleanup](../docs/release-2.12-integration.md) record the private database comparison.
[Removed paths and retained coverage](../docs/release-2.12-cleanup.md) document cleanup.
The orchestrator ships this release. This branch does not push or deploy.

## Release 2.11 integration

The source baseline is `892b6bca`, release 2.10.2.
Include auto-set starter preservation from `424c19da`.
The final trade curve uses exponent 5 and a 5% fair band. Migration `20261214005700` removes the flat roster spot value.
Apply all pending migrations through `20261214003900`, including version 023 with `--include-all`.

Apply the earlier pending migrations through 033 first.
Deploy the updated `refresh-views` Edge function before migrations 035–037.
Then apply 035–039, deploy the remaining Edge functions, and release the frontend.
Migration 038 skips forecast requests for scopes removed by league deletion cascades.
Migration 035 alone works with the current worker.
Migration 036 breaks the current worker's scheduler behavior if DB runs first.
It routes `forecast-inputs` and `notification-scan` jobs to `refresh-views` with `schedulerChunk` payloads.
The release 2.10.2 worker ignores that field and performs an ordinary view refresh.
It never calls `run_scheduler_chunk`, so forecast invalidation and notification scans remain pending.
Migration 037 depends on that chunk worker for forecast expiry wakeups.
The orchestrator deploys Edge after DB push, so its default order is incompatible with this package.
Override that order before a production rollout. This integration performs no deployment.

## Trade curve

Apply `20261214003100_trade_value_curve.sql`, then release Edge and frontend together.
The model version becomes `onenumber-trade-curve-v6`.
The migration queues one reanalysis run for pending, accepted, and completed trades.
Saved source values and pick values stay on the 0–1000 scale.
The shared engine applies exponent 5 when summing player and pick values.
Open roster spots add no value, and migration `20261214005700` queues model v6 once.
Teams over a roster limit also lose the curved value of their required cuts.
The model bump replaces exponent 5.5 and recomputes stored values once.
Current card reads prefer the published curved analysis and preserve its roster terms.
Older offline analyzer snapshots are discarded by model version.
Original estimates remain in trade estimate history.
Fingerprint, scan, and pacing functions are unchanged.

Run `node tests/e2e/trade-curve-mini.mjs verify` on the private mini checkout.
Run `node tests/e2e/trade-curve-report.mjs` for the backup comparison.
The [trade curve report](../docs/trade-curve.md) records the real trades, roster terms, and browser evidence.

## Release order for this release

The supplied production head is `20261214005900`, with 741 migrations.
Apply `20261214006000_inactive_pickup_drops.sql`, then merge the frontend. Edge source is unchanged.

### Historical release 2.14.5 order

The production head was `20261214005800`, with 740 migrations.
Apply `20261214005900_bounded_first_screens.sql`, then merge the frontend. Edge source is unchanged.

### Historical release 2.14.4 order

From production head `20261214005700`, apply `20261214005800_league_trade_history.sql`, then merge the frontend.

### Historical release 2.14.3 order

From production head `20261214005600`, deploy Edge first, then apply `20261214005700_trade_curve_no_flat_roster_value.sql`, then merge the frontend.
The old worker cannot process a v6 reanalysis job, so Edge must lead.

### Historical release 2.14.1 order

From production head `20261214005500`, apply `20261214005600_perf_beacon_screens.sql`, then deploy Edge, then merge the frontend.
The beacon route and the client send the new screen names only after the database accepts them.

### Historical release 2.14 order

From production head `20261214005409`, the eight Release 2.14 migrations applied with `--include-all` through `20261214005500_pre_tipoff_member_failures.sql`.
Database, then Edge, then merge the frontend.
Migration 04300 precedes the shared startup wrapper; 04600 precedes the `refresh-views` model field; 05500 precedes `lineup-optimizer`.
The private ordered upgrade and fresh reset produce identical catalogs.

### Historical release 2.11 rollout

The table below records earlier migrations already included in the supplied production head.
For an older baseline, deploy the release 2.11 `refresh-views` worker before migrations 035–037.
The earlier notification versions require `--include-all` when absent from that older history.

| Migration | Change |
| --- | --- |
| `20261214000300_bound_notification_season_scan.sql` | Bounds season notification candidates before recipient joins. |
| `20261214000400_gate_idle_lineup_notifications.sql` | Skips impossible idle lineup notification scans. |
| `20261214000600_reuse_notification_insert_plan.sql` | Reuses the notification insert plan. |
| `20261214000900_refresh_queue_contention.sql` | Keeps completion events out of screen invalidation. |
| `20261214001100_trade_preview_read_only.sql` | Keeps trade preview FAAB checks read only. |
| `20261214001300_trade_analyzer_revalue.sql` | Enables saved trade revaluation and renews validated cache leases. |
| `20261214001400_pace_trade_revaluation_work.sql` | Paces background revaluations behind screen work. |
| `20261214001500_matchup_forecast_inputs.sql` | Reuses unchanged forecasts and prepares dates once per matchup. |
| `20261214001700_ingest_identity_noop.sql` | Avoids unchanged identity and stat writes. |
| `20261214001900_l4d_background_cost.sql` | Bounds pick predictions and skips unchanged game-day writes. |
| `20261214002100_l3e_scans.sql` | Narrows projection and work scans and indexes internal identity reads. |
| `20261214002300_l5c_players_response.sql` | Omits unused ownership entries from ordinary free-agent responses. |
| `20261214002500_trade_locks_drop_only.sql` | Lets trade- and claim-reserved players change lineup slots; drops stay blocked. |
| `20261214002700_live_fallback.sql` | Orders live source snapshots and records ESPN or NBA provenance. |
| `20261214002900_offers_do_not_lock.sql` | Allows overlapping pending offers and cancels conflicts when a trade is accepted. |
| `20261214003100_trade_value_curve.sql` | Curves trade packages at exponent 5, values net roster spots at 25, and queues model v5 once. |
| `20261214003300_autoset_keep_starters.sql` | Retains omitted starters and fills eligible slots during auto-set. |
| `20261214003500_keep_live_refresh_essential.sql` | Refreshes live matchup totals during scheduler shedding, in chunks of eight. |
| `20261214003600_defer_cron_candidate_scans.sql` | Moves forecast input fingerprints and notification candidates into bounded worker chunks. |
| `20261214003700_preserve_forecast_expiry_wakeups.sql` | Wakes early cache expiries through an indexed worker queue. |
| `20261214003800_skip_deleted_forecast_scopes.sql` | Skips deleted forecast scopes during league cascades. |
| `20261214003900_screens_after_211.sql` | Bounds fallback-stat reads and cached trade JSON reads after screen authorization. |

Apply `20261214002700_live_fallback.sql`, then deploy `live-poll` after tonight's games.
ESPN is the primary live source. NBA supplies each game's fallback and all official final statistics.
The nightly `daily-stat-corrections` and morning `missing-final-stats` jobs keep their existing NBA paths.
NBA certification replaces differing live values, including when its final revision predates a live source timestamp.
Live ESPN cannot mark a game Final, set `stats_synced_at`, or create a certified revision.

The changed RPCs are `public.save_live_game_stats_atomic`, `public.save_live_scoreboard_atomic`, and `public.save_live_feed_snapshot_atomic`.
Their canonical sources are in `supabase/sql/functions/by-name/public/`.
The first two retain their signatures. The new RPC adds source timestamps without changing generated client contracts.
`private.live_feed_state` protects source ordering per game and tracks players witnessed by NBA live data.
`private.live_nba_witnesses` and `private.reconcile_espn_live_stats` support live provenance.
The versioned NBA final save removes provisional ESPN-only rows inside its existing transaction, then stores the complete NBA box.
The original NBA certification function and correction jobs are unchanged.
Rows previously witnessed by NBA remain covered by the existing completeness guard.
Failed certification rolls back provisional cleanup.
The first stats snapshot adds one indexed read of that game's existing player rows; later ticks reuse the stored witness list.
`private.live_feed_audit` records the source, revision time, progress, and changed row count for each changed snapshot.
Duplicate snapshots add no audit entries. Legacy NBA writes retain an unknown source revision and a known write time.
Audit rows follow their game's lifetime.
The live scoreboard waits for the NBA final box and certified stats before closing a game.
A scoreboard that reaches Final before its box no longer starts a 30-minute final-stats backoff.

Each live tick requests one ESPN scoreboard, then summaries only for matched live games.
Failed ESPN requests back off for 20, 40, 80, then 120 seconds in the worker.
Inconsistent snapshots use a 10-second cooldown and retry on the next 20-second tick.
This leaves room for request timing differences and prevents transient header differences from compounding into minutes of delay.
Backoff resets after success. A new worker starts with a fresh backoff state.
NBA requests and ESPN requests are bounded at 2.5 seconds, including response bodies.
Live NBA box timestamps use their explicit timezone or the game's ET offset; object modification time is the fallback.
Official NBA revision timestamps keep their existing representation.
Live ESPN identities use one small batched read. Missing or ambiguous links use NBA for that game.
An indexed game-state read occurs inside the existing live save transaction.
Score-input source-lock conflicts retry only the failed RPC, up to three times, within the live tick deadline.
Failed inputs log the game, league season, week, RPC, and SQL code.

The private replay uses project `pt4bafablelv` and block `636xx`.
Run `node scripts/season-sim/live-fallback-mini.mjs --compare --session=<recorded-session-file>` in that lane's mini checkout.
The comparison executes this branch and the unmodified `892b6bca` live poll against the same recorded sources.
The replay measures scoring-play wall clocks through database matchup publication and checks totals with the season score oracle.

The measured result is in [the recorded comparison](../tests/fixtures/live-espn/evidence/espn-primary-comparison.json).
On 11 point changes from two live games, ESPN primary reached 83.01 seconds p95; the release NBA poll reached 20 minutes 32.10 seconds with 20 minutes of injected NBA lag.
The measured reduction is 19 minutes 9.09 seconds.
Matchup oracle, source timeout recovery, request limits, and identity-read limits passed.
The accepted latency target is under 90 seconds, allowing for ESPN summary freshness. The measured 83.01-second result meets that target.
The replay enforces this target and exits unsuccessfully when it fails.
`--measure-only` records a diagnostic comparison without enforcing the latency target.
Recorded ESPN summaries contain header and player-score differences; these require the per-game NBA fallback.
One player stat change took 68.79 seconds just to appear in the recorded summary, before database publication.
The release keeps the recorded public ESPN endpoints and rejects inconsistent snapshots.
This sample covers one live window, rather than a full historical season or production behavior.

Release readiness includes `origin/main` at `892b6bca`, which is already an ancestor of this branch.
The release-history and security-catalog attestations were regenerated on a fresh private database with all 702 migrations through `20261214002700`.
The local read-only security catalog passed against that database.
Full Vitest passed: 4791 tests, zero failures, and 48 skipped; 505 files passed and 16 were skipped.
Regenerating the contracts resolved the earlier release and attestation failures.
`npm run check:quality` passed, including application, test, E2E, harness-boundary, and core typechecks.
The season harness passed 359 tests. Deno passed 68 tests with four steps and one ignored test.
Five SQL assertion groups passed on the migrated private database.
The recorded live comparison passed the accepted under-90-second target.
Commands and results are in [the release-readiness record](../tests/fixtures/live-espn/evidence/release-readiness.json).

The partial score-sync failure was reproduced with the NBA source lock returning `PT409` from `capture_score_inputs`.
A bounded retry of that input publishes healthy scores without repeating the provider reads.
NBA CDN timeouts were also reproduced and recover through ESPN.
The restored backup's score sync passes in isolation.
Historical aggregate logs omit the exact failed game inputs, so their complete original cause remains unverified.

For the game-night safety package, deploy the updated `refresh-views` Edge worker first.
Then apply migrations 035, 036, and 037.
The new worker also accepts the existing refresh and trade payloads.
Migration 036 introduces the chunk payloads and their service-only RPC.
Migration 035 can run with the existing worker.
This package does not require the pending trade-scan migrations 026–028.

`20261214001100_trade_preview_read_only.sql` can ship alone.
It preserves locking checks for trade writes and waiver claims.
Its standalone source commit is `1c07b175d19a2cbb049d9e4315851f15e3a3974b`.

Existing in-flight revaluations drain before another revaluation starts for the same league.
The pace permits one new background revaluation per league per minute.
Foreground trade estimates retain priority and bypass that pace.
The pacing migration preserves urgent schedules and invocation outcomes.
It needs no Edge or frontend release.

Apply `20261214001500_matchup_forecast_inputs.sql` for matchup input fingerprints and shared preparation.
Unchanged inputs keep forecast work clean. Unchanged expiry renews the existing result.
The existing forecast worker accepts the completed empty date list.
The [L4b measurements](../docs/perf-l4b.md) record the private backup comparison.

The contention repair follows `20261214000700_future_pick_years.sql`.
This repair changes one database trigger function and needs no Edge or frontend deployment.
Activity events still publish one league version per transaction.
They do not invalidate derived standings, matchup totals, player averages, or trade values.
Mixed transactions with source-data changes still queue a refresh.
This removes the queue-row request from worker completion and preserves its idempotent receipt.
The concurrency recipe holds a refresh transaction open while another connection completes a worker.

## Release 2.7 trade input order

Database, then Edge, then merge the frontend.
Apply `20261214000700_future_pick_years.sql` before clients read the future pick setting.
The existing Edge settings endpoint accepts the new JSON field without an Edge code change.

The supplied production head is `20261211000400`, with 683 migrations.

### Trade input migration

Pause trade dispatch, apply `20261212000100_trade_revaluation_inputs_fast.sql`, then deploy `refresh-views`.
Resume dispatch when both versions agree.
This change needs no frontend release.
This integration makes no production request.

### L3e scan changes

Apply `20261214002100_l3e_scans.sql` through the normal database migration runner.
It changes `public.get_league_projection_rows` and `public.work_dashboard` without changing signatures or grants.
It adds partial indexes for work retention and dashboard counts.
It adds a function-expression index for player identity lookups and analyzes players.
It grants `service_role` execute on `private.player_identity_name(text)` so service-role imports can maintain that index.
Apply the complete migration, including that grant.
No existing index is dropped.
The shared projection helper is used by screen and forecast reads.
The dashboard and retention indexes overlap L4 bookkeeping.
Measurements and remaining replay checks are in [the L3e report](../docs/perf-l3e.md).
This lane makes no production request.

### Screen read cost migration

Apply `20261213000100_screen_view_costs.sql`, then `20261213000200_unpartition_player_game_stats.sql`.
The second migration replaces the 70 stats partitions with one regular table.
It preserves rows, access rules, triggers, references, and all nine original indexes.
A unique ID index adds native identity protection at every transaction isolation level.
It removes stats partition maintenance and keeps durable stats outside log retention.
Prepared forecast averages still use the selected roster and maintained season totals.
Projection reads still share their upcoming and regular-game calendars.
The game-day partition filter is removed because it slows the regular table.

Pause workers with `public.set_worker_paused(true, 'Stats table migration')` and let active workers finish.
Apply both migrations in order through the normal migration runner.
The copy, exact row comparison, index build, and table swap commit together.
The copy uses a heap first; indexes build in bulk before the swap.
Policies, grants, and triggers are prepared before the SHARE lock.
Only functions with catalog dependencies on the old relation or row type are rebuilt.
Foreign keys enforce new writes immediately and validate old rows after the copy lock is released.
The migration keeps private resume state until validation finishes.
If validation stops after the swap, rerun the same migration; it resumes validation without copying again.
Do not restore the retired table or resume workers before validation completes.
The quarter-CPU, 1 GiB rehearsal and phase timings are in the linked report.
Budget fifty seconds in production using four times the slowest quarter-CPU rehearsal, including the migration runner.
Both statement and elapsed-time caps are 300 seconds; the lock wait cap stays three seconds.
Run `ANALYZE public.player_game_stats;` after the migration commits.
Check the regular table, row count, triggers, grants, and screen reads before resuming workers.
Resume with `public.set_worker_paused(false, 'Stats table migration verified')`.
Keep the regular table on application rollback; repair database changes with a forward migration.

The change preserves screen and worker JSON and requires no client release.
The [screen benchmark](../tests/db/unpartition-player-stats.md) records read measurements.
The [migration follow-up](../tests/db/unpartition-migration.md) records quarter-CPU timings and failure recovery.
This rehearsal makes no production request.

### Slow screen reads after release 2.8

Apply `20261214000500_slow_screens.sql` as one transaction.
It changes six function bodies. Signatures, grants, and tables stay the same.
The pending trade count and player projection query reuse PL/pgSQL plans.
The roster uses a generic plan. Trade lists request only card and block fields.
The full trade details and trade block responses retain their existing defaults.

The [private benchmark](../tests/db/slow-screens.md) records fresh and warm calls at one and quarter CPU.
It compares serialized JSON for three managers on a live day and an off day.
Run its SQL timing guard and the screen, player search, and projection recipes before rollout.
No data backfill or worker pause is needed for these read function changes.

Follow with `20261214000501_slow_screen_addendum.sql` for player details, the full trade block, and revaluation inputs.
It also batches trade cards through `get_trade_cards`, which verifies the caller and every requested trade.
Only authenticated and service roles may execute that helper.
The worker retains its three-second statement cap. Its fresh benchmark guard is 300 ms.
The [addendum results](../tests/db/slow-screens.md#production-addendum-1910-utc) include a full forty-card page and exact JSON checks.

## Release 2.6 historical contract

Apply the database changes, deploy Edge functions, then merge the frontend.
The integration base is `origin/main` at `78c01b8c`, the release 2.5 source.
Production currently stops at migration `20261123000100` for the recorded release 2.6 baseline, with 621 migrations.
This integration makes no production request.
The release planner must verify the applied prefix during an authorized rollout.

Release 2.6 adds four migrations and reaches 625 migrations through `20261124000400`.
The incoming migration timestamps have zero collisions.
Keep all four versions unchanged and apply them in this order.

| Migration | Change |
| --- | --- |
| `20261124000100_trade_value_fetch_retries.sql` | Releases failed daily claims and queues bounded value-fetch retries. |
| `20261124000200_trade_estimate_reanalysis.sql` | Adds versioned trade re-analysis and preserves original quotes in history. |
| `20261124000300_trade_estimate_pick_inputs.sql` | Shares pick inputs and bounds replacement-player reads. |
| `20261124000400_pick_predictions_and_ranking_cleanup.sql` | Stores pick predictions, chains daily refreshes, and removes ranking work. |

Deploy all five changed Edge functions after the database upgrade.
This list uses the release runner import graph against `origin/main` at `78c01b8c`.
It includes callers of changed shared files.
`_shared` is not a deployable function.

| Edge function | Change |
| --- | --- |
| `api` | Uses imported trade scoring, refreshes pick predictions, and runs versioned trade re-analysis. |
| `dispatcher` | Closes vacuum connections after failures and uses a real-time deadline. |
| `refresh-views` | Uses the changed shared dynasty engine. |
| `sync-rankings` | Returns HTTP 410 and performs no fetch or write. |
| `sync-trade-values` | Bounds source attempts, releases failed claims, and schedules retries. |

Use this rollout order:

1. Record compatible frontend and Edge rollback artifacts and verify the applied database prefix.
2. Pause scheduled work through `public.set_worker_paused(true, reason)` and let running work settle.
3. Apply every pending migration through `20261124000400` in version order.
4. Check migration fingerprints, function sources, catalog grants, and database types.
5. Deploy all five Edge functions and check their internal authorization.
6. Import the recorded value fixture and verify publication, pick refresh, and trade re-analysis on a private stack.
7. Merge and deploy the frontend after the database and Edge checks pass.
8. Resume scheduled work and inspect the first daily chain and retry outcomes.

The daily scheduler queues `sync-trade-values` after 07:15 America/New_York.
Quarter-hour checks preserve catch-up and one work key per Eastern day.
League-local midnight waiver work stays in the same scheduler.
The database permits one successful live value publication per Eastern day.
A failed fetch releases its claim and preserves the last complete snapshot.
An abandoned claim expires after three minutes.

Each source attempt has a 75-second body-inclusive timeout, with at most two attempts.
A 110-second source deadline bounds both attempts and their one-second pause.
Database work, cleanup, and invocation checks retain the controlled 135-second total budget.
The service-only retry RPC is `public.fail_trade_value_sync(uuid, integer, date, boolean)`.
Its arguments are request ID, retry number, Eastern retry date, and the schedule flag.
Failure queues the next retry for 30 minutes later, up to retry 4.
Duplicate callbacks cannot enqueue extra work.
The original fetch error stays on the failed work item and sync record.

Successful publication queues `pick-predictions` with the source hash.
The worker calls the internal `api/trades/pick-values-work` route.
It stores closed-form tier odds and values for each league's picks.
`complete_pick_prediction_refresh` rejects stale hashes and incomplete league refreshes.
Completion queues trade re-analysis with history version `onenumber-trade-v1-picks-v1`.
Already converted trades remain unchanged on replay.
Original quotes and earlier history remain available.

Migration `20261124000400` removes pending `sync-rankings` work and its work kind.
It drops `private.enqueue_rankings(timestamptz)` and its hourly scheduler call.
The retired weekly gate formerly runs Monday after 07:00 Eastern, with later-week catch-up.
No separate ranking cron remains to unschedule.
The legacy ranking write RPC returns a retirement result without changing stored values.
Keep the HTTP 410 endpoint through the rollback window.

Private verification uses project `pt4bafabler26` and ports `586xx`.
The upgrade starts at all 621 supplied-head migrations and applies the four-file suffix.
A fresh 625-migration rebuild produces the same four generated artifacts.
The fixed audit anchor stays at 329 migrations through `20261005000003`.
The approved range contains 296 migrations.
The recorded security baseline stays at 564 migrations through `20261029000800`.
Its candidate suffix contains 61 migrations; the verified live prefix determines the actual pending suffix.
[Migration history](../docs/production-migration-history.md#release-26-candidate) records the range.
[Integration evidence](../docs/release-2.6-integration.md) records checks, limits, and every changed file.
[Trade values](../docs/trade-values.md) defines scoring, predictions, matching, and retries.

Keep RPC compatibility, realtime publications, receipts, roster history, and saved trade quotes through rollout.
If a phase fails, stop promotion and restore compatible frontend and Edge artifacts.
Pause scheduled work before recovering an incompatible worker pairing.
Preserve additive data and versioned history.
Repair database behavior with a reviewed forward migration.

## Historical rollout reference

Release 1 includes the final-stat recheck and revision-fence migrations.
Those changes remain in the schema.
Their former `daily-stat-corrections` cron is removed by the work queue migration.
Current corrections run as queued work through `dispatch_work`.
Use the operator pause below for an incident.
Do not unschedule a retired per-job cron.

## Rule references

[Roster lifecycle](../docs/roster-lifecycle.md) defines claims, taxi eligibility, reservations, trade plans, and season transitions.
[Trade estimates](../docs/trade-estimates.md) defines frozen quotes and separate historical revaluation.
[Matchup forecasts](../docs/matchup-forecasts.md) defines inputs, stale results, publication, and concurrency.
[Source monitoring](../docs/source-monitoring.md) defines providers, projection windows, corrections, and retention.
[Verification](../docs/verification.md) lists current recipes and release prerequisites.

## Next release

This section contains deferred cleanup, outside the release 2.7 migration steps.
The SQL below is not installed by this release.

Drop `leagues.taxi_rule` after the deployed client and its rollback retire.
Every league now uses NBA rookies or fewer than 65 career regular-season games.

The current client accepts `player_stats` and scoped activity changes.
Retain compatibility topics until older clients and their rollback artifacts retire.
Drop `standings.waiver_priority` after old Edge writers and their rollback window retire.
Live waiver order already uses `waiver_priorities`.


Release 2.7 publishes exactly the tables watched by the current client.
Keep the app-wide hint stream and screen subscriptions through rollback.

The checked-in attestations cover all 675 migrations through `20261209000500`.
Recheck their source fingerprints before deployment.
The published attestations retain the recorded release 1 baseline.

Keep the Expo objects while the deployed Edge release or its rollback can use them.
The client cannot update `profiles.push_token`; the service role keeps access.
The database phase also keeps receipt tickets and their current leases.

First ship an Edge release that removes Expo delivery, receipt polling, and legacy storage access.
Settle pending tickets and close its rollback window.
Then assign a new migration version after the repository head for the SQL below.
This SQL stays outside `supabase/migrations` until that release.
It requeues pending tickets, replaces the queue routines, and then removes the legacy objects.
Remove their canonical sources and catalog entries, then regenerate types for that release.

```sql
DROP TRIGGER IF EXISTS normalize_legacy_push_token_write ON public.profiles;
DROP FUNCTION IF EXISTS private.normalize_legacy_push_token_write();

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_atomic(
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  title text,
  body text,
  data jsonb,
  category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 200);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  RETURN QUERY
  WITH pending AS MATERIALIZED (
    SELECT queued.id, queued.member_id, queued.event_type, queued.data, queued.category,
      queued.available_at, queued.created_at, member.user_id, league.deleted_at
    FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id=queued.member_id
    JOIN public.leagues league ON league.id=member.league_id
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.available_at<=now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at<=now()-make_interval(secs=>v_lease_seconds))
    ORDER BY queued.available_at,queued.created_at,queued.id
    LIMIT CASE WHEN v_limit=0 THEN 0 ELSE GREATEST(v_limit,100) END
    FOR UPDATE OF queued SKIP LOCKED
  ), lineup_contexts AS MATERIALIZED (
    SELECT DISTINCT pending.data->>'leagueId' AS league_key,pending.data->>'memberId' AS member_key
    FROM pending WHERE pending.event_type IN ('lineup_inactive','lineup_empty')
      AND coalesce(pg_input_is_valid(pending.data->>'leagueId','uuid'),false)
      AND coalesce(pg_input_is_valid(pending.data->>'memberId','uuid'),false)
  ), lineup_current AS MATERIALIZED (
    SELECT context.league_key,context.member_key,candidate.event_type,candidate.league_id,
      candidate.member_id,candidate.game_date,candidate.player_id
    FROM lineup_contexts context CROSS JOIN LATERAL private.notif_lineup_candidates_scoped(
      clock_timestamp(),context.league_key::uuid,context.member_key::uuid) candidate
  ), stale AS MATERIALIZED (
    SELECT pending.*, CASE WHEN pending.deleted_at IS NOT NULL THEN 'league_deleted'
      WHEN pending.event_type IN ('lineup_inactive','lineup_empty') THEN
        CASE WHEN NOT EXISTS(SELECT 1 FROM lineup_current candidate
          WHERE candidate.league_key=pending.data->>'leagueId' AND candidate.member_key=pending.data->>'memberId'
            AND candidate.event_type=pending.event_type AND candidate.league_id::text=pending.data->>'leagueId'
            AND candidate.member_id::text=pending.data->>'memberId' AND candidate.game_date::text=pending.data->>'gameDate'
            AND (pending.event_type='lineup_empty' OR candidate.player_id::text=pending.data->>'playerId')) THEN 'stale' END
      WHEN private.notif_is_stale(pending.event_type,pending.data) THEN 'stale' END AS reason
    FROM pending
  ), deferred AS MATERIALIZED (
    SELECT stale.*, CASE WHEN stale.reason IS NULL THEN private.notif_draft_deferred_until(stale.event_type,stale.data) END AS resume_at
    FROM stale
  ), classified AS MATERIALIZED (
    SELECT deferred.*, CASE WHEN deferred.reason IS NOT NULL THEN deferred.reason
      WHEN deferred.resume_at IS NULL AND NOT private.notif_preference_enabled(deferred.user_id,deferred.event_type,deferred.category)
        THEN 'preferences_disabled' END AS suppression
    FROM deferred
  ), delivery AS MATERIALIZED (
    SELECT classified.id FROM classified WHERE classified.suppression IS NULL AND classified.resume_at IS NULL
    ORDER BY classified.available_at,classified.created_at,classified.id LIMIT v_limit
  ), changed AS (
    UPDATE public.notification_outbox queued SET
      suppressed_at=CASE WHEN classified.suppression IS NOT NULL THEN clock_timestamp() ELSE queued.suppressed_at END,
      suppression_reason=COALESCE(classified.suppression,queued.suppression_reason),
      available_at=CASE WHEN classified.resume_at IS NOT NULL AND classified.suppression IS NULL
        THEN LEAST(classified.resume_at,clock_timestamp()+interval '1 minute') ELSE queued.available_at END,
      claimed_at=CASE WHEN delivery.id IS NOT NULL THEN clock_timestamp() ELSE NULL END,
      claim_token=CASE WHEN delivery.id IS NOT NULL THEN gen_random_uuid() ELSE NULL END
    FROM classified LEFT JOIN delivery ON delivery.id=classified.id
    WHERE queued.id=classified.id AND (classified.suppression IS NOT NULL OR classified.resume_at IS NOT NULL OR delivery.id IS NOT NULL)
    RETURNING queued.*
  )
  SELECT changed.id,changed.claim_token,changed.member_id,changed.title,changed.body,
    changed.data||jsonb_build_object('notificationEvent',changed.event_type,'outboxId',changed.id),changed.category
  FROM changed JOIN delivery ON delivery.id=changed.id
  ORDER BY changed.available_at,changed.created_at,changed.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET delivered_at = now(),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET attempt_count = attempt_count + 1,
         available_at = now() + make_interval(
           secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)
         ),
         dead_lettered_at = CASE WHEN attempt_count + 1 >= 12 THEN now() ELSE NULL END,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Unknown notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dead_letter_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET dead_lettered_at = now(),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Permanent notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_process_trades(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= p_now
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= p_now
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.available_at <= p_now
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= p_now - interval '60 seconds')
  ) THEN
    PERFORM private.work_enqueue('process-trades',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

UPDATE public.notification_outbox
   SET claimed_at = NULL, claim_token = NULL, available_at = now()
 WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND expo_ticket_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.record_notification_outbox_ticket_atomic(uuid, uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.claim_notification_receipts_atomic(integer, integer);
DROP FUNCTION IF EXISTS public.defer_notification_receipt_state_atomic(uuid, uuid, text, integer, boolean);
DROP FUNCTION IF EXISTS public.register_push_token_atomic(uuid, text, text);
DROP FUNCTION IF EXISTS public.revoke_push_token_atomic(text, text);
DROP FUNCTION IF EXISTS public.clear_push_token_for_user_atomic(uuid, text);

DROP INDEX IF EXISTS public.notification_outbox_receipt_queue;
DROP INDEX IF EXISTS public.notification_outbox_expo_ticket_unique;
DROP INDEX IF EXISTS public.profiles_push_token_lookup;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_push_token_revocation_pair,
  DROP CONSTRAINT IF EXISTS profiles_push_token_revocation_hash_format;

ALTER TABLE public.profiles
  DROP COLUMN push_token,
  DROP COLUMN push_token_revocation_hash;

ALTER TABLE public.notification_outbox
  DROP COLUMN expo_ticket_id,
  DROP COLUMN push_token,
  DROP COLUMN ticketed_at,
  DROP COLUMN receipt_attempt_count;
```

## Worker incident controls

Cron calls `public.dispatch_work()` directly.
Replacing the Edge `dispatcher` does not pause the SQL scheduler or other workers.
Pause new scheduled work with the operator RPC:

```sql
SELECT public.set_worker_paused(true, 'Investigating database load');
```

Inspect the saved control and queue before resuming:

```sql
SELECT * FROM private.worker_controls;
SELECT * FROM public.work_dashboard();
SELECT * FROM public.retention_dashboard();
```

Confirm that existing workers finish or lose their leases.
Check failed work and invocation outcomes before retrying.
Retain dead items for diagnosis.
Do not delete queue rows to hide a failure.
Resume only after the cause is understood and the relevant local checks pass:

```sql
SELECT public.set_worker_paused(false, 'Database checks pass');
SELECT * FROM public.work_dashboard();
```

Confirm that due work starts and failure counts stop growing.

Only the service role and database owner can call this RPC.
The flag lives in the singleton `private.worker_controls` row.
The scheduler checks it before enqueueing or claiming work.
The flag does not cancel a statement already running.
Service-role requests have a three-second statement budget and a 250ms lock budget.
The cron command sets a five-second outer statement budget before calling the dispatcher.
A timeout set inside an already running SQL function does not replace that outer budget.
Retention statements delete at most 5,000 rows and skip locked candidates.
Each retention pass stops starting new helpers after two seconds.
The queue admits at most eight active workers.
Screen refresh claims one season and at most 20 trade valuations per run.
Incomplete valuation sets keep the season dirty for continuation.

Apply `20261114000100_bounded_worker_database_work.sql`, then `20261114000200_worker_pause_control.sql`.
Deploy `refresh-views` after these migrations.

## Dispatcher transaction budget

Apply `20261114000300_bounded_dispatch_transactions.sql` after the worker safeguards.
This change needs no Edge deployment.
Each dispatch claims one item at a time, with at most eight claims.
It starts no new item after two seconds.
The existing cron command keeps its five-second statement limit and 250 ms lock limit.
Unclaimed items remain pending; no lease starts before an item can run.
A blocked item records its error before the transaction commits.
The dispatcher advisory lock skips overlapping runs.
Run `npm run test:db:dispatcher-contention` on an idle private stack.
The recipe holds worker rows and the HTTP queue while it checks bounded dispatch and overlap.
A queued HTTP backlog alone does not prove insertion contention.
Startup timeouts occur before SQL execution; retain full error context when investigating a failed statement.

Duplicate active work returns before insertion, using the existing active-work index.
This avoids waiting on an unrelated lease update during a uniqueness check.
The unique index still rejects concurrent duplicate inserts.

Apply `20261114000400_player_birthdate_simulated_clock.sql` after the dispatcher transaction repair.
The birthdate constraint uses `private.valid_player_birthdate(date)` with `now()::date`.
This keeps both date bounds and lets the replay install its supported transaction clock.
No Edge deployment is required.

## Release 2.6 post-database checks

Run the four release 2.6 migrations in version order after every earlier pending migration.
Check the upgraded database with both current and rollback consumers before frontend promotion.
Run the focused recipes in [verification](../docs/verification.md), then the full release checks.
Keep local fixture evidence separate from rollout evidence.
This integration does not authorize a hosted release.

## Release 2.6.2 live scoring lock fix

Apply migration `20261128000100_live_poll_injury_contention.sql` after `20261124000400`.
It replaces `private.recount_changed_player_careers` so the career trigger locks a player row only when the appearance count changes.
Deploy every Edge function; `_shared/databaseRetry.ts`, `live-poll`, `sync-player-injuries` and `sync-players` changed.
The injury worker now commits one short transaction per player batch, and the live scoring loop retries a lock timeout per tick.
Evidence and the blocking statement pair are in [docs/live-scoring-lock-contention.md](../docs/live-scoring-lock-contention.md).
Rollback: redeploy the release 2.6.1 Edge functions; the migration is safe to keep.

## Release 2.6.3

The integration starts at `045f2d09`, the release 2.6.2 source.
The supplied production head is `20261128000100`, with 626 migrations.
The two migrations reach `20261130000100`, with 628 migrations.

| Order | Migration | Change |
| --- | --- | --- |
| 1 | `20261129000100_restore_hashtag_rankings.sql` | Restores Hashtag readers, ranking writes, and hourly work. Preserves OneNumberHoops trade inputs. |
| 2 | `20261130000100_player_page_speed.sql` | Keeps Hashtag sources and computes league fantasy averages once per dynasty read. |

Hashtag supplies five-year points, three-year points, dynasty ranks, and rookie ranks.
Future picks use the original release 2.4 curve.
OneNumberHoops supplies trade calculations, estimates, pick predictions, and re-analysis.
Its stored player values and pick bands stay intact.
The [reader map](../docs/dynasty-rankings-restoration.md) records each source.
The dynasty reader keeps its arguments, columns, grants, and snapshot values.

Only one Edge function changes against `origin/main` at `045f2d09`.

| Edge function | Required deployment |
| --- | --- |
| `sync-rankings` | Deploy the restored worker, parser, matching, forms, and view selection. It replaces the retired HTTP 410 handler. |

Use this rollout order:

1. Record rollback artifacts and verify the applied database prefix.
2. Pause scheduled work with `public.set_worker_paused(true, reason)` and let running work settle.
3. Apply both migrations in the listed order after every earlier pending migration.
4. Check migration fingerprints, function sources, catalog grants, and database types.
5. Deploy `sync-rankings` and verify its internal authorization.
6. Check all three Hashtag views and preserved trade values on a private stack.
7. Deploy the frontend after database and Edge checks pass.
8. Resume scheduled work and inspect the first ranking refresh.

The hourly scheduler retains weekly success keys and Monday's 07:00 Eastern gate.
The worker writes three-year, rookie, then five-year rows.
Daily trade work and league-local midnight waiver work stay scheduled.

Rollback: pause scheduled work and restore the previous frontend.
Keep both migrations and the restored `sync-rankings` worker.
Trade input signatures and stored OneNumberHoops rows remain compatible.
Keep work paused if worker compatibility is uncertain.
Use a reviewed forward migration for a database repair.
Resume work after the relevant private checks pass.

[Migration history](../docs/production-migration-history.md#release-263-candidate) records the combined range.
[Integration evidence](../docs/release-2.6.3-integration.md) records checks and every changed file.

## Release 2.7

The source baseline is `origin/main` at `acafdf80`, release 2.6.4.
The supplied database head is `20261130000100`, with 628 migrations.
The ordered pending set adds 47 migrations and reaches 675 through `20261209000500`.
Twenty-eight pending versions precede the supplied head. Include all missing versions in numeric order.
All versions are distinct. No migration is renumbered.

| Order | Migration | Change |
| --- | --- | --- |
| 1 | `20261119000100_skip_unchanged_lineup_slots.sql` | Skip unchanged lineup slots. |
| 2 | `20261119000200_churn_table_storage_policy.sql` | Churn table storage policy. |
| 3 | `20261119000300_player_identity_lookup.sql` | Player identity lookup. |
| 4 | `20261119000400_reviewed_player_provider_links.sql` | Reviewed player provider links. |
| 5 | `20261119000500_reconcile_missing_final_stats.sql` | Reconcile missing final stats. |
| 6 | `20261119000600_provider_write_gate.sql` | Provider write gate. |
| 7 | `20261119000700_terminal_work_retention.sql` | Terminal work retention. |
| 8 | `20261119000800_application_session_limits.sql` | Application session limits. |
| 9 | `20261119000900_schedule_write_gate.sql` | Schedule write gate. |
| 10 | `20261119001000_append_event_time_index.sql` | Append event time index. |
| 11 | `20261119001100_preserve_lock_free_stat_resolution.sql` | Preserve lock free stat resolution. |
| 12 | `20261119001200_preserve_incomplete_season_calendar.sql` | Preserve incomplete season calendar. |
| 13 | `20261119001300_partition_beacons_and_receipts.sql` | Partition beacons and receipts. |
| 14 | `20261119001400_scope_notification_lineup_checks.sql` | Scope notification lineup checks. |
| 15 | `20261119001500_partition_events_and_invocations.sql` | Partitions events and invocations. Preserves column grants, policies, and version triggers. |
| 16 | `20261119001600_complete_public_read_retention.sql` | Complete public read retention. |
| 17 | `20261119001700_refresh_trade_value_statistics.sql` | Refresh trade value statistics. |
| 18 | `20261125000100_partition_player_game_stats.sql` | Partition player game stats. |
| 19 | `20261125000200_partition_notification_outbox.sql` | Partition notification outbox. |
| 20 | `20261125000300_restore_missing_final_stats_schedule.sql` | Restore missing final stats schedule. |
| 21 | `20261125000400_restore_native_outbox_uniqueness.sql` | Restore native outbox uniqueness. |
| 22 | `20261125000500_preserve_reconciliation_after_rankings_retirement.sql` | Preserve reconciliation after rankings retirement. |
| 23 | `20261125000600_batch_lineup_notification_claims.sql` | Batch lineup notification claims. |
| 24 | `20261125000700_skip_unchanged_forecast_queue_writes.sql` | Skip unchanged forecast queue writes. |
| 25 | `20261125000800_remove_roster_member_prefix_index.sql` | Remove roster member prefix index. |
| 26 | `20261125000900_index_pending_edge_invocations.sql` | Index pending edge invocations. |
| 27 | `20261126000100_corroborate_null_team_player_identities.sql` | Repairs nine player identities from matching source evidence. |
| 28 | `20261127000100_database_probe_repairs.sql` | Versions league events and moves public-read retention into dispatcher work. |
| 29 | `20261201000100_daily_screen_statistics.sql` | Daily screen statistics. |
| 30 | `20261201000200_preserve_reconciliation_with_hashtag_rankings.sql` | Keeps missing-stat repair and updates existing guarded minute jobs. |
| 31 | `20261201000300_reuse_current_forecast_projection_inputs.sql` | Reuse current forecast projection inputs. |
| 32 | `20261201000400_index_recent_score_dispatches.sql` | Index recent score dispatches. |
| 33 | `20261201000500_share_player_average_refresh_source.sql` | Share player average refresh source. |
| 34 | `20261201000600_bound_hint_drain.sql` | Applies the guarded five-second hint drain through cron.alter_job. |
| 35 | `20261201000800_defer_contended_balance_publications.sql` | Defer contended balance publications. |
| 36 | `20261201000900_draft_only_realtime.sql` | Publishes the exact union of current client subscriptions. |
| 37 | `20261201001000_cap_worker_dispatch.sql` | Cap worker dispatch. |
| 38 | `20261201001100_player_game_keyset.sql` | Player game keyset. |
| 39 | `20261201001200_guard_minute_workers.sql` | Keeps both minute workers bounded and prevents overlapping runs. |
| 40 | `20261201001300_separate_forecast_publication.sql` | Separate forecast publication. |
| 41 | `20261201001400_gate_idle_screen_refresh.sql` | Gate idle screen refresh. |
| 42 | `20261202000100_authorize_trade_receipt_replays.sql` | Requires current membership and request ownership before trade receipt replay. |
| 43 | `20261204000100_trade_structured_legality.sql` | Adds structured legality, incoming destinations, and atomic saved roster moves. |
| 44 | `20261205000100_pending_asset_locks.sql` | Locks pending assets and preserves transaction-bound executor proof. |
| 45 | `20261206000100_trade_pick_labels.sql` | Adds pick ownership to activity readers and shared pick labels. |
| 46 | `20261207000100_release27_dispatcher_convergence.sql` | Combines scheduler work and handles trade capacity conflicts during waiver processing. |
| 47 | `20261209000500_matchup_forecast_season_fallback.sql` | Adds current-season averages to both forecast context readers. |

`public.dispatch_work` owns public-read retention and its bounded hourly prune.
Catch-up starts after minute 17. The separate `public-read-retention` cron job is unscheduled.
The scheduler keeps Hashtag rankings, missing-final-stat repair, and daily table analysis.
The dispatcher claims at most four workers and stops after its transaction budget.
Realtime retains all 16 tables watched by the current client.
Version polling complements those subscriptions.
The hint drain and cron-history cleanup retain their maintenance jobs.

Migrations `20261201000200`, `20261201000600`, and `20261201001200` use `cron.alter_job` on existing job IDs.
They accept the supplied live minute schedules and advisory-lock commands.
The final commands retain five-second statement limits, 250-millisecond lock limits, and session overlap guards.
Repeated application preserves job IDs, counts, schedules, and commands.

Ordinary roster writes enforce pending asset locks.
Saved trade moves require the executor context, private transaction proof, and an exact saved destination.
Waiver workers handle the HTTP-compatible trade capacity conflict code as a failed roster claim.
All three former bug recipes require fixed behavior. `tests/db/known-bugs.json` is empty.

### Realtime publication

The static subscription check follows direct calls, imported watch helpers, aliases, maps, and dynamic imports.
It compares that union with the final publication across ordered migrations.
It rejects both missing subscriptions and unwatched published tables.
Unresolved watch expressions or later publication changes fail the check.

| Table | Active client reader |
| --- | --- |
| `draft_budgets` | Auction draft subscription. |
| `draft_picks` | Trade screen watch helper. |
| `drafts` | Auction and rookie draft subscriptions. |
| `league_change_hints` | App-wide league change stream. |
| `league_members` | League list and player support. |
| `leagues` | League list. |
| `matchup_forecasts` | Matchup forecast hook. |
| `nominations` | Auction draft subscription. |
| `roster_players` | Player support. |
| `snake_draft_picks` | Rookie draft subscription. |
| `trade_block_items` | Trade screen watch helper. |
| `trade_items` | Trade screen watch helper. |
| `trade_participants` | Trade screen watch helper. |
| `trade_vetos` | Trade screen watch helper. |
| `trades` | Trade screen watch helper. |
| `waiver_claims` | Member claims stream. |

The migration removes six unwatched tables from the supplied 22-table publication.
They are `draft_room_members`, `matchups`, `roster_transactions`, `waiver_priorities`, `waiver_wire_log`, and `weekly_lineups`.
No active client subscribes to `draft_room_members`.
The unused `leagueScreenWatches` factory does not create a subscription.
Its unused history and settings watches do not enter the union.
The migration version and filename stay unchanged. Reset the private stack before regenerating attestations.

### Changed Edge functions

The release runner import graph compares this source with `origin/main` at `acafdf80`.
These seven deployable functions change, including callers of changed shared files.

| Function | Change |
| --- | --- |
| `api` | Adds structured trade legality and saved roster-plan responses. |
| `backfill` | Preserves incomplete schedule calendars through the shared schedule helper. |
| `matchup-forecast` | Uses fresh live projections without frozen values and keeps limited estimates numeric. |
| `process-trades` | Uses scoped notification lineup checks. |
| `refresh-views` | Uses the changed shared schedule helper. |
| `sync-players` | Links player sources using matching identity evidence. |
| `sync-schedule` | Preserves incomplete schedule calendars. |

### Rollout

1. Verify the applied database history and record compatible frontend and Edge rollback artifacts.
2. Pause dispatcher work and let running work settle.
3. Apply all 47 missing migrations in the listed order with older pending versions included.
4. Check migration fingerprints, column grants, function sources, catalog grants, and database types.
5. Confirm public-read retention has no separate cron job. Check both guarded minute worker definitions.
6. Deploy the seven listed Edge functions, then release the frontend.
7. Resume dispatcher work. Check saved trade execution, ordinary asset locks, retention, and daily analysis.

The private rehearsal uses only `pt4bafabler27` and ports `600xx` on the mini.
The catalog, database types, and both attestation files regenerate there.
The forecast worker requires the final migration before deployment.
It keeps frozen values and marks substituted estimates in the frontend.
No production service receives a request during integration.

### Rollback

Restore compatible frontend and Edge artifacts and pause affected work.
Keep the additive schema, partitioned data, native outbox keys, and dispatcher ownership.
Preserve receipts, saved trade plans, identity links, pending locks, and executor proof checks.
Use a reviewed forward migration for database repairs.
Do not restore obsolete cron jobs or remove partitions that contain retained data.

[Integration evidence](../docs/release-2.7-integration.md) records exact checks, limits, and every changed file.

## Release 2.7.1

The source base is release 2.7 at `f1c1f6ec`.
The supplied production head is `20261209000500`, with 675 migrations.
The candidate adds four distinct versions and ends at `20261210000300`, with 679 migrations.
No migration version changes.

| Order | Migration | Change |
| --- | --- | --- |
| 1 | `20261209000600_league_schedule.sql` | Adds the member's season schedule read. |
| 2 | `20261210000100_scheduler_watchdog.sql` | Measures scheduler health and limits work under load. |
| 3 | `20261210000200_certify_inactive_zero_rows.sql` | Removes absent inactive zero rows before final certification and records removed rows. |
| 4 | `20261210000300_isolate_screen_statistics.sql` | Moves statistics into an independent daily job and retires queued analysis work. |

### Changed Edge functions

The release runner's import graph compares this candidate with `origin/main` at `f1c1f6ec`.
Shared file changes affect six deployable functions.

| Function | Change |
| --- | --- |
| `api` | Registers the Schedule view. |
| `backfill` | Includes the corrected shared stat certification. |
| `live-poll` | Ignores absent inactive zero rows during certification. |
| `season-boundary` | Includes the corrected shared stat certification. |
| `sync-scores` | Includes the corrected shared stat certification. |
| `sync-stats` | Ignores absent inactive zero rows during certification. |

### Rollout

1. Verify the applied history matches the supplied production prefix.
2. Save compatible frontend and Edge rollback artifacts.
3. Pause dispatcher work and let active work finish.
4. Apply the four migrations in numeric order.
5. Verify migration fingerprints, function sources, grants, database types, and the realtime publication.
6. Deploy the six listed Edge functions.
7. Release the frontend with Schedule, Daily Total, matchup navigation, and selected-day lineup controls.
8. Resume dispatch and read `public.get_scheduler_health()` with the service role.
9. Check schedule reads, stat certification, scheduler recovery, and the independent statistics job.

The realtime publication remains the same 16-table client watch set.
Schedule uses the existing screen version cache and adds no subscription.
Private rehearsal uses `pt4bafabler271` and ports `612xx` on the mini.
The function catalog, database types, and both attestations regenerate from that private database.

### Watchdog thresholds

Health examines at most 40 recent cron rows within five minutes.
The success ratio uses completed dispatcher runs.
Any cron startup timeout enters `paused`.
Dispatcher success below 50% also enters `paused`.
Success below 80%, average duration above three seconds, or unavailable health enters `shed`.
A restricted state needs ten continuous healthy minutes to recover.
A missing sample, failed check, or check gap above 90 seconds resets recovery.
Manual pause remains separate and stops all dispatch.

In `shed`, only live polling, scoring, stat sync, waivers, trades, and invocation reconciliation can run.
Live polling runs on even minutes; waiver enqueue runs every 15 minutes.
In `paused`, only waivers, trades, and live polling can run, once per five-minute dispatch batch.
Nonessential queued work keeps its due date and attempt count.
The four-worker cap and two-second dispatch budget remain in force.

`public.get_scheduler_health()` reads the last saved measurement without changing state.
Read `level`, manual `paused`, `checked_at`, `healthy_since`, and `last_reduced_dispatch_at` first.
The nested `health` object includes samples, success ratio, durations, startup timeouts, and backend counts.
The nested `hint` contains the latest transition reason and revision.
Alert on stale `checked_at` as well as restricted levels.
The watchdog cannot recover a dispatcher that cron cannot start.
[Scheduler operations](../docs/operations-scheduler.md) explains the allowed work and transition log.

### Statistics job

`screen-statistics` runs at `15 10 * * *` in its own cron connection.
Its command sets a ten-minute statement timeout, a two-second lock timeout, and 16 MB maintenance memory.
It analyzes one named relation per statement and continues after a lock timeout.
The 15 targets retain their existing autovacuum settings.
Partitioned parents still need manual statistics; their ANALYZE also visits child partitions.

The migration retires `analyze-screen-table` and marks outstanding items dead.
Retired kinds cannot enqueue, claim, or execute work.
Retention, partition creation, and trade triggers no longer analyze tables.
Catalog checks reject inline ANALYZE, VACUUM, and REINDEX outside the statistics job.
A slow daily job cannot cancel the dispatcher's separate statement.

[Isolation evidence](../docs/release-2.7.1-statistics-isolation.md) records production-shaped timings and concurrency checks.

### Rollback

Pause dispatch before restoring compatible frontend and Edge artifacts.
Keep the additive schema and stat cleanup audit rows.
Do not restore removed inactive rows blindly; later certified snapshots may supersede them.
Use a reviewed forward migration for database repairs.
If the watchdog requires removal, restore the release 2.7 dispatcher definition through a reviewed forward migration.
Keep manual pause active until health and queue checks pass.
Keep statistics outside dispatch during rollback.
Disable the independent cron job if needed; do not restore the retired inline work kind.
This integration performs no production rollout or rollback.

[Integration evidence](../docs/release-2.7.1-integration.md) records exact checks and every changed file.

## Release 2.7.2

The source base is release 2.7.1 at `2adcfa9a`, with 679 migrations.
This release adds four migrations and ends at `20261211000400`, with 683 migrations.

| Order | Migration | Change |
| --- | --- | --- |
| 1 | `20261211000100_scope_trade_revaluation.sql` | Separates trade valuation from screen refresh and bounds changed-player work. |
| 2 | `20261211000200_league_schedule_skipped_weeks.sql` | Shows skipped weeks without an opponent or score. |
| 3 | `20261211000300_forecast_inputs_bound.sql` | Adds the parent history index and bounds forecast game lookups without changing forecast outputs. |
| 4 | `20261211000400_trade_taxi_incoming_only.sql` | Limits trade Taxi moves to eligible incoming players. |

Pause refresh and trade valuation dispatch while applying this release.
Apply the four migrations in numeric order, then deploy `api` and `refresh-views`, then release the frontend.
Resume dispatch after the database and Edge versions agree.
Keep these additive database changes during a frontend or Edge rollback.
Use a reviewed forward migration for database repairs.

[Integration evidence](../docs/release-2.7.2-integration.md) records the private rehearsal and check counts.


## Trade input performance

Apply `20261212000100_trade_revaluation_inputs_fast.sql`, then deploy `refresh-views`.
The source base is release 2.7.2 at `64ada45a`.
The migration brings the database to 684 migrations.
No frontend or other Edge deployment is required.
The migration retires pending work with old fingerprint keys.
New scans create one reusable latest-input work item per trade and model.
Existing publications receive one new valuation after the fingerprint format changes.

Checks now read source revisions, trade terms, pick metadata, balances, and freshness boundaries.
They queue work without reading full player inputs.
Publication checks use the same fingerprint.
The full read checks its fingerprint again before returning, so concurrent input changes require a retry.
Source revisions cover inserts, updates, deletes, and truncation.
No-op updates leave them unchanged.
Roster and cached-average revisions stay scoped to their league or season.

The full read retains the existing numeric rules and JSON input fields.
Fractional scoring aggregates bounded game rows without repeated player scans.
The new game index belongs to the partitioned parent, including future partitions.
The generic-plan trace visits ten current-season partitions and skips all 60 unrelated partitions.
PostgreSQL documents this [runtime partition pruning](https://www.postgresql.org/docs/17/ddl-partitioning.html#DDL-PARTITION-PRUNING).

### Changed SQL functions

| Function | Change |
| --- | --- |
| `private.track_trade_input_revision` | Track relevant input changes without a shared writer lock. |
| `private.compact_trade_input_revisions` | Fold retired writer counters without changing fingerprints. |
| `private.trade_revaluation_is_live` | Detect current-season games in progress. |
| `private.begin_trade_revaluation` | Limit live valuations to one per trade every ten minutes. |
| `private.refresh_queue_trade_revaluation` | Coalesce changes without postponing the first due time. |
| `private.refresh_queue_trade_revaluations` | Discover open trades and compact retired counters. |
| `private.trade_revaluation_input_version` | Read the cheap input fingerprint. |
| `private.trade_value_fantasy_averages` | Preserve exact scoring with bounded statistics reads. |
| `private.trade_value_player_inputs` | Use the bounded average reader. |
| `private.build_trade_estimate_inputs` | Bound replacement-player averages. |
| `public.get_dynasty_pick_values` | Bound replacement values used for picks. |
| `public.get_trade_revaluation_inputs` | Attach the fingerprint and reject a changing input snapshot. |
| `private.refresh_trade_values` | Validate publication without rebuilding inputs. |
| `public.view_refresh_work` | Check, queue, and claim a trade valuation. |

### Reproduction

The private benchmark restores the supplied backup at migration `20261029000800`, then migrates to the source base.
It contains 245,097 player game rows, 2,618 players, and three open trades.
The database uses one Docker CPU and 1 GB during measurements.
The benchmark refuses to run unless scheduled jobs are disabled.
Only the restore uses 4 GB because the dump contains large INSERT statements.
The backup's storage tables differ from the local storage service; all application tables restore completely.

Ordinary backup reads do not reproduce the reported production timeout.
Two concurrent reads with supported three-decimal scoring both hit the three-second statement limit.
The old fallback joins game rows by stat identity without a partition key and repeats the work per player.
The repaired calls finish in 71.804 and 73.048 ms under the same limit and generic planning.
These figures describe the private mini, not production latency.

### Before and after

Each ordinary measurement covers 30 reads of all three open trades.
The check measurement includes queue handling.
The old check combines its input read and queue call in one measured statement.
Times measure PostgreSQL execution; outer planning, network, and Edge execution time are excluded.
Buffers include shared hits and reads, not distinct pages.

| Call | Version | Mean ms | p95 ms | Maximum ms | Mean buffers | DB ms per three-trade scan |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Discovery | Before | 0.558 | 0.738 | 2.414 | 148 | 0.558 |
| Discovery | After | 0.593 | 0.723 | 3.168 | 202 | 0.593 |
| Check | Before | 21.846 | 26.855 | 55.457 | 2,287 | 65.538 |
| Check | After | 0.435 | 0.527 | 5.307 | 226 | 1.305 |
| Full input | Before | 22.502 | 29.660 | 52.862 | 2,269 | 67.505 |
| Full input | After | 14.585 | 15.078 | 41.346 | 1,893 | 43.754 |
| Publication | Before | 21.881 | 26.444 | 55.769 | 2,279 | 65.644 |
| Publication | After | 0.328 | 0.397 | 5.815 | 116 | 0.983 |

The unchanged three-trade scan, including discovery, falls from 66.096 to 1.898 ms of database time, a 97.1% reduction.
Its check calls use 90.1% fewer shared-buffer accesses.
When every trade changes, discovery, checks, input reads, and publication total 46.635 ms, compared with 131.741 ms before.
Publication measurements use a minimal valid valuation payload.
The old worker reuses inputs from its check; the new worker reads them only for changed trades.

Forced generic and custom plans also pass the timing guards and input parity checks.
Across those runs, the largest full-read p95 is 15.639 ms and the largest check p95 is 0.579 ms.
Their largest measured ordinary statement is 40.708 ms.

### Nested statement profiles

Every executed nested statement is captured with `auto_explain.log_nested_statements`, ANALYZE, and BUFFERS.
The ordinary traces contain 497 statements before and 370 after.
The fractional-scoring trace exposes the costly fallback.
These cold, instrumented values include tracing overhead and stay separate from the timing table.

| Fractional-scoring statement | Before ms | Before buffers | After ms | After buffers |
| --- | ---: | ---: | ---: | ---: |
| Full input call | 7,061.055 | 723,951 | 78.555 | 31,536 |
| Input construction | 7,057.226 | 721,881 | 69.744 | 27,574 |
| Replacement selection | 6,872.684 | 685,776 | 40.324 | 21,228 |
| Player inputs | 144.526 | 16,456 | 24.201 | 5,101 |

The replacement statement is first by both time and buffers among the inner input statements.
The new grouped raw-stat read takes 18.625 ms and 2,543 buffers in that trace.
The parent index and runtime pruning keep historical partitions out of execution.

The ordinary trace ranks full input construction first by time and buffers.
Its outer call takes 53.229 ms and 26,097 buffers after the fix, including cold planning within PL/pgSQL.
Its replacement selection takes 21.022 ms and 18,425 buffers.
Warm call measurements appear in the table above.

### Verification commands

Set `SUPABASE_DB_URL` to the private loopback database on port 61922.
Set `PANCAKE_TEST_DB_PORT=61922` for the catalog and control runners.
The profile scripts need the private database administrator role for `auto_explain`.
Keep their output directory outside the repository because it contains backup input payloads.
Run the before commands on the source base and the after commands after applying the migration.
Disable scheduled jobs again after every database reset.

```sh
psql "$SUPABASE_DB_URL" -c "ALTER SYSTEM SET cron.launch_active_jobs=off" -c "SELECT pg_reload_conf()"
python3 tests/db/trade-revaluation-bench.py before ../evidence
python3 tests/db/trade-revaluation-pressure.py before ../evidence
python3 tests/db/trade-revaluation-bench.py after ../evidence
python3 tests/db/trade-revaluation-parity.py
PGOPTIONS='-c plan_cache_mode=force_generic_plan' python3 tests/db/trade-revaluation-pressure.py after ../evidence
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-revaluation-fast.sql
node tests/db/trade-revaluation-controls.mjs
```

The SQL recipe rejects an injected full-input read during checking or publication.
It verifies scoring parity, correction and deletion invalidation, no-op writes, authorization, and timing limits.
A delayed negative control must fail its timing guard.
The six broken SQL variants must fail their corresponding assertions.
Backup parity compares UTF-8 bytes for every input field except the changed fingerprint and the observation/cache envelope.
The catalog and both attestations regenerate from the private database through their generators.


### Initial verification

The full Vitest run passes 4,628 tests and skips 48; two checks initially fail.
The release note gains the new migration in its release-order section.
The report test receives an isolated replay fixture instead of depending on a clean working tree.
The affected checks and related contracts then pass all 869 focused tests.
The full suite runs once.

The original four SQL recipes pass 72 assertions, including the timing guard's delayed negative control.
All five deliberately broken SQL variants fail as expected.
Both ordinary and fractional input comparisons pass byte parity for all three open trades.
The changed Edge entrypoint type-checks, and its 11 tests pass.
Lint, application types, test types, function sources, and the live function catalog pass.
Generated function and release attestations cover all 684 migrations.

The private stack stops after verification, and transferred backup copies are deleted.
No production service, push, pull request, deployment, or CI run is used.

### Addendum baseline

The review adds write overhead, writer contention, and live-game revaluation limits.
The first comparison uses 30 interleaved pairs with the original revision triggers enabled and disabled.
A live tick updates 177 real-player stat rows across eight game saves.
The player import changes 50 players through the actual import function.
The projection write uses the actual 500-row upsert shape.

| Write | Without triggers ms | With triggers ms | Added ms | Added percent |
| --- | ---: | ---: | ---: | ---: |
| Eight live game saves | 149.802 | 155.103 | 5.302 | 3.54% |
| Eight final game saves | 168.802 | 175.679 | 6.876 | 4.07% |
| Player import | 37.125 | 42.606 | 5.481 | 14.76% |
| Projection upsert | 16.919 | 17.723 | 0.804 | 4.75% |

The player import fails both overhead limits.
Two real writers on separate seasons also expose the shared revision lock.
Its longest observed wait is 100.261 ms across 30 pairs.
A three-hour simulation produces 120 valuations per trade per hour and 5,816.914 database ms per hour.
The changes below resolve both failures and reduce live valuation volume.

### Write cost and contention

Each backend maintains its own revision counter.
The fingerprint sums the counters, so concurrent writers update different rows and reversed commit order still changes the fingerprint.
Scans compact retired backends without changing the sum or touching active writers.

Stat triggers compare scoring columns, not whole rows.
Player updates use a column-specific row condition and one durable revision write per transaction.
A transaction-local count also detects later player changes within the same transaction.
Nested aggregate refreshes rely on the parent stat revision instead of writing another revision.

The final comparison repeats the same 30 interleaved pairs on one CPU and 1 GB.
Each table entry is a paired mean for one SQL statement.
The eight live and final statements together change 177 rows per tick.
The projection write changes 500 rows; the player import changes 50 rows.

| Statement | Without triggers ms | With triggers ms | Added ms | Added percent |
| --- | ---: | ---: | ---: | ---: |
| Largest relative live-save overhead | 16.933 | 17.582 | 0.650 | 3.84% |
| Largest relative final-save overhead | 19.796 | 20.595 | 0.798 | 4.03% |
| Player import | 36.490 | 37.431 | 0.941 | 2.58% |
| Projection upsert | 17.120 | 17.303 | 0.183 | 1.07% |

All statements meet both mean-overhead limits.
The full live tick adds 1.741 ms; the full final tick adds 0.236 ms.
Thirty concurrent live/final writer pairs show zero observed revision lock waits, down from 100.261 ms.
The first transaction stays open for 160 ms while the second writes different player rows.
The last pair commits in reverse order and verifies both fingerprint changes.

### Live-game volume

Pending work keeps one latest-input key per trade and model.
Repeated changes replace the fingerprint without moving its due time later.
A per-trade claim limits valuations to one every ten minutes, including model changes.
The worker reads current inputs when that claim succeeds.
The last game ending makes pending final values due immediately.

The simulation advances three hours in 30-second ticks for all three open trades in one league.
It executes the real check, queue, input, and publication functions.
The final run publishes full analysis payloads captured by the runtime test.
The initial comparison uses minimal valid publication payloads.
Source writes are outside these revaluation totals.

| Measurement | Before | After |
| --- | ---: | ---: |
| Live valuations across three hours | 1,080 | 54 |
| Valuations per trade per hour | 120 | 6 |
| Revaluation DB ms per hour | 5,816.914 | 460.151 |
| Share of one CPU-hour | 0.162% | 0.013% |
| Retained work items | 1,083 | 3 |
| Final-value delay after last game | 0 seconds | 0 seconds |

The final simulation's longest measured statement is 21.249 ms.
The SQL guards reject excess live frequency, stale final values, and database time above 1% of one CPU.

### Full runtime verification

The runtime recipe executes the actual Deno analysis and saves its complete result.
It verifies deterministic analysis and exact equality between computed and saved values.
Thirty rounds cover every open trade, for 90 complete valuations.
Database and analysis containers each receive half a CPU, sharing a total budget of one CPU.
The database retains its 1 GB memory limit.

| Stage | Mean ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| Begin claim | 0.487 | 0.514 | 2.280 |
| Full input read | 25.892 | 54.905 | 95.536 |
| Actual analysis | 0.073 | 0.107 | 0.744 |
| Complete publication | 1.898 | 1.846 | 36.858 |
| End to end, including loopback transport | 31.923 | 59.746 | 106.829 |

Every stage meets p95 below 300 ms and maximum below one second.
An injected 1,100 ms analysis delay fails the timing guard.

Run SQL recipes as the local `postgres` role and tracing scripts as local `supabase_admin`.
The runtime recipe runs only in the private mini checkout and restores the database CPU limit on exit.
It removes its own analysis container and bundle directory.

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v phase=after -f tests/db/trade-revaluation-writers.sql
python3 tests/db/trade-revaluation-contention.py after
bash tests/db/trade-revaluation-runtime.sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v phase=after \
  -v revaluations="$(cat ../trade-revaluation-runtime-values.json)" -f tests/db/trade-revaluation-night.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-revaluation-coalesce.sql
node tests/db/trade-revaluation-controls.mjs
```

### Final addendum checks

Five SQL recipes pass 122 assertions; all six broken controls fail at their intended assertions.
Both byte-parity comparisons pass for all three open trades.
The affected Vitest checks pass 862 tests; the Deno worker tests pass 12.
Lint, application types, test types, function sources, and the live catalog pass.
The catalog and both attestations regenerate through their generators.
The full Vitest suite is not repeated after the addendum, following the instruction to defer it until before a push.
No push is performed.

## Future draft years

Apply `20261214000700_future_pick_years.sql` before releasing the client.
League rules use typed columns, so `leagues.future_pick_years` follows that convention.
The default remains 3. Commissioners can choose 1 through 10 during any season.
Increasing the setting creates each member's own three rounds for the additional years.
Lowering blocks years containing transferred picks or trade references.
Cleanup keeps used picks, assigned picks, activity references, and every foreign key reference.
The migration changes only OFFICIAL LEAGUE `faab8d8f-6a60-4bbc-8f5d-44050b652cdd` to 5.
It inserts missing 2031 and 2032 assets without changing existing picks.
Existing league version triggers publish setting and inventory changes to clients.
Repeated migration runs preserve pick IDs and ownership.

The external value source publishes three draft classes.
For later classes, the SQL reader extends each round and tier using its last annual value ratio.
The ratio is bounded between 0.5 and 1, with 0.9 when the previous value is absent or zero.
The fourth class is the third class times that ratio; the fifth repeats that decay.
Round 3 retains the existing replacement value floor after decay.
Source values and timestamps remain unchanged. The imported three-class source contract stays intact.
The existing strategy model already compounds annual decay without a year limit.
Pick predictions and trade estimates both consume the extended SQL value bands.

Changed functions: `public.create_league`, `public.join_league_by_invite_code`,
`public.advance_season_atomic`, `private.assert_trade_window`,
`public.update_league_settings_atomic`, `public.view_picks`,
`public.get_dynasty_pick_values`, `public.get_pick_prediction_inputs`,
`private.trade_revaluation_input_version`, and new helper `private.reconcile_future_picks`.
`private.roll_setup_league_seasons` already shifts all existing assets with no fixed window.

Pick labels display the stored pick year directly, matching the requested 2028–2032 window.
Valuation source keys still use the prior summer NBA draft year.
`private.expire_pending_trades_for_lost_asset` uses the same stored year in notices.

Commissioners edit the rule in a dedicated Future draft picks card with its own Save button.
It loads the saved column directly and uses the existing configuration RPC.
The form stays within app, components, and lib; no hook change is required.

# L4c ingest cost

`20261214001700_ingest_identity_noop.sql` avoids repeated merge work for unchanged, uniquely named player source links.
The player lock and identity checks remain in place.
The stat saver also filters unchanged rows before attempting inserts and retains its conflict guard.
Measurements and verification are recorded in `docs/perf-l4c.md`.


## Pending trade offers

Apply `20261214002900_offers_do_not_lock.sql` before the frontend.
Pending offers permit overlapping players and picks for every participant.
Players on either side still block drops, waiver drops, IR moves, and Taxi moves.
Lineup changes remain available.
The roster snapshot keeps roster locks and supplies separate `tradeLockedAssets` for the builder.
Accepted trades retain exclusive assets and reserve their outgoing FAAB until processing or veto.
FAAB balance checks run at acceptance and processing. Sending checks amount syntax only.
FAAB is fungible; accepting one offer reduces the budget available to another acceptance.
Acceptance cancels other pending offers sharing a player or pick, including offers from another team.
It also cancels pending roster plans that depend on the traded player.
Processing repeats the cancellation for offers created during review.
Cancelled offers use the existing withdrawn status and notification event.
Both sides receive Trade Cancelled with the stored reason.

Changed functions: `private.locked_assets`, `private.is_reserved_trade_asset`,
`private.assert_not_reserved_trade_asset`, `private.guard_trade_plan_reservations`,
`private.prevent_accepted_or_inactive_roster_move`, `private.prevent_accepted_trade_asset_roster_delete`,
`private.create_trade_offer`, `private.create_multi_team_trade_offer`,
`private.check_trade_legality`, `private.assert_trade_assets_acceptance_ready`,
`private.enqueue_trade_status_notification`, `private.cancel_pending_trades_for_moved_assets`,
`private.cancel_conflicting_trade_offers`, `private.activate_rookie_draft_league_if_ready`,
`public.complete_accepted_trade_atomic`, and `public.view_roster`.
The cancellation trigger runs on accepted and completed transitions.
Acceptance and completion retain their team locks and ownership checks.
Completion cancels conflicts before roster ownership updates can expire them.

Run `node tests/e2e/offers-do-not-lock-mini.mjs setup` on the assigned mini checkout.
Use only project `pt4bafableol` and loopback ports 638xx.
The setup restores the supplied backup, blocks external HTTP, disables scheduled jobs,
clears delivery destinations, and removes the transferred backup.
Run `node tests/e2e/offers-do-not-lock-mini.mjs baseline` to reproduce the old rejection.
Run `node tests/e2e/offers-do-not-lock-mini.mjs migrate` to apply the candidate.
Run `node tests/e2e/offers-do-not-lock-mini.mjs verify` for all SQL recipes and races.
Run `node tests/e2e/offers-do-not-lock-mini.mjs attest` to update the migration attestations.
Run `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/offers-do-not-lock.sql`.
Run `node tests/e2e/offers-do-not-lock-concurrency.mjs` for the acceptance race.
Run `node tests/e2e/offers-do-not-lock-mini.mjs stop` when verification finishes.

Private verification restores one league, 2,618 players, and 245,097 game rows.
The baseline rejects a second overlapping offer. The candidate permits three simultaneous offers.
Fourteen SQL recipes pass 309 assertions. Five acceptance races pass 50 assertions.
Each race produces one accepted trade, one cancelled offer, two notifications, and one transfer.
The recipes cover received offers, picks, FAAB, stale ownership, roster plans, review locks,
waiver drops, IR, Taxi, lineup moves, and cancellation notifications.
The migration attestations regenerate from the private database and cover all 702 migrations.

Focused Vitest passes 943 tests across 14 files. Quality checks pass on Node 22.
The full Vitest run executes once: 3,926 pass, 852 initially fail, and 48 skip.
Migration attestation drift accounts for 844 failures. The new migration requires regenerated attestations.
Eight failures come from a rankings fixture using an Eastern date for a Pacific league cache.
The fixture now uses the league timezone. All affected files pass their focused reruns.
The full suite is not repeated.

The private stack stops, the transferred backup is removed, and its config is restored.
No production service, push, pull request, deployment, or CI run is used.
[Verification counts](../tests/evidence/offers-do-not-lock.json) pin the tested migration hash.
## Auto-set keeps starters

Apply `20261214003300_autoset_keep_starters.sql`, then release `lineup-optimizer`.
The migration changes `public.auto_set_lineup_atomic_unchecked` and `public.apply_pre_tipoff_lineup`.
The callers `public.auto_set_lineup_atomic` and `public.auto_set_lineup_service_atomic` keep their signatures and checks.
`public.get_pre_tipoff_lineup_context` already supplies the current starters, roster, eligibility, and game locks.
The button and automatic switch use the same date optimizer.
Remaining season dates and the next seven days are optimized independently. No day-forward copy path creates lineups.
The pre-tipoff worker uses the same assignment objective.
Playing projections take priority. Equal scores retain current starters. Remaining eligible slots use bench fallbacks.
Intentional zero-point fallbacks include `expected_active: false` in pre-tipoff requests.
Active proposals still retry when injury or schedule inputs change before apply.
Game-time locks keep their existing checks.
Run `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/autoset-keep-starters.sql` on a private stack.
The recipe rolls back its fixture and reports eleven checks.
Run the mini Deno tests in `supabase/functions/lineup-optimizer` for Edge behavior.
The [backup replay](../tests/evidence/autoset-keep-starters/README.md) records Thursday and Friday evidence.

## Screen reads after 2.11

Apply `20261214003900_screens_after_211.sql` after 038. No Edge update is required.
The five screen entry points validate the caller with `view_context` before reading as their owner.
This avoids repeating row policies for each returned asset.
Foreign managers, leagues, seasons, missing identities, malformed parameters, and deleted leagues remain rejected.
Fallback fantasy averages use bounded player lookups in `get_trade_cards`, `view_roster`, and `view_trade_block`.
Trade cards read each distinct player and each published v5 JSON document once for the authorized page.
The response fields and model calculations stay the same.

Changed functions: `public.view_players`, `public.view_trades`, `public.view_trade_block`,
`public.view_player`, `public.view_home`, `public.get_trade_cards`, and `public.view_roster`.

[Screen measurements](../tests/db/screens-after-211.md) record the private replay and its limits.

## Pipeline night

Apply `20261214005400_pipeline_context_bound.sql` after the release 2.12 head `20261214005302` at main `c84063c4`.
Then apply `20261214005401_pipeline_poll_idle.sql`.
This also adds a conservative idle probe to `public.get_live_poll_work`.
Season averages use the selected roster IDs before reading the existing averages view.
Prepared and unprepared contexts retain their complete returned JSON.
Apply `20261214005402_pipeline_dispatch_inline.sql` next.
It inlines three scheduler helper bodies in `private.enqueue_scheduled_work`.
The helpers remain callable with their existing behavior.
Then apply `20261214005403_pipeline_hint_idle.sql`.
It returns before planning an empty score-hint drain in `private.flush_player_stats_hints`.
Apply `20261214005404_pipeline_hint_lease.sql` next.
Calls with request headers retain the original lease fence, including empty queues.
Then apply `20261214005405_forecast_claimable_wakeups.sql`.
Forecast admission uses the same pending-input gate as claims. Input chunks wake computation when their scope becomes ready.
Ship it with `20261214005406_forecast_input_recovery.sql` and `20261214005407_forecast_ready_priority.sql`. Do not ship `05405` or `05406` alone.
Only empty forecast workers blocked on due inputs share the input chunks' background priority. Ready forecasts retain their original priority.
The repair makes pending or failed input jobs due and enqueues a recovery job when overdue requests exist and no live input lease exists.
It preserves attempts, leases, requests, forecast values, and future expiry deadlines.
The additional private helper changed is `work_claim`. Its readiness check is inline; no new function or permission is added.
Apply `20261214005408_background_kind_fairness.sql` next.
Background kinds rotate by their last claim time, then take their oldest due row.
The private `work_kinds.last_claimed_at` column retains service history across dispatcher backends and restarts.
Claims select one row at a time. Ineligible input chunks cannot hide other work behind a fixed candidate limit.
Urgent and ready forecast priority, four slots, input chunk capacity, league pacing, leases, and retries remain in force.
Already due pending and failed rows need no additional repair.
Changed private helpers are `enqueue_matchup_forecasts`, `enqueue_scheduled_work`, and `complete_forecast_input_chunk`.
Forecast expiry rules and the Edge workers are unchanged.
No Edge or shared helper changes are required.

The [pipeline measurements](../tests/db/pipeline-night.md) compare current main with the candidate.
They include all requested pipeline items, discarded planner experiments, exact row diffs, and live publication checks.
Run `node --experimental-strip-types tests/db/pipeline-night.mjs candidate` on the private pipeline stack.
Run `node tests/db/pipeline-night-verify.mjs` there for SQL, Deno, and failing quality controls.

Apply `20261214005409_notification_scan_safeupdate.sql` next.
The API session loads `safeupdate`, which rejects a `DELETE` without a `WHERE` clause.
The notification scan cleared its dirty marker without one, so every scan started through `refresh-views` failed.
The marker delete now uses `WHERE true`. `tests/db/regressions/notification-scan-safeupdate.sql` runs the scan with the guard loaded.
