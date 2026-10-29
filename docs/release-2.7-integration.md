# Release 2.7 integration evidence

All eleven requested branches enter in order from `acafdf80`.
All integration commits contain `[skip ci]`.
No push, pull request, deployment, CI run, or production connection occurs.
Verification uses the private mini database and synthetic fixtures.
All requested scoped checks pass. The private stack is stopped.

## Checks

Overlapping scopes must not be added together.

| Command or check | Observed result |
| --- | --- |
| Added database unit tests | 9 passed across 3 files; 0 failed. |
| Core calendar test | 5 passed; 0 failed. |
| Lineup changes | 107 passed; 1 skipped; 0 failed across 8 files. |
| Trade block averages | 4 passed; 0 failed. |
| Harness tests | 103 passed across 5 files; 0 failed. |
| Season tests | 345 passed; 0 failed. |
| Database tooling tests on the Mac | 51 passed; 5 database cases deferred to the mini; 0 failed. |
| Database tooling cases on the mini | All 5 pass. The checkpoint case uses the installed container pg_dump. |
| Release history attestation test | 745 passed; 0 failed. |
| Catalog, function source, and Edge compatibility tests | 78 passed across 3 files; 0 failed after refreshing the deferred notification SQL. |
| WebKit regression | 56 passed; 0 failed. Covers 40 screen adapters and 16 Analyzer cases. All artifact checks pass. |
| Performance lab unit tests | 175 passed across 35 files; 0 failed. |
| Edge Deno tests | 548 passed with 16 steps; 0 failed; 12 opt-in cases ignored across 109 files. |
| `npm run check:quality` | Passes lint, type checks, source parity, dead code, shared Edge generation, surface inventory, and design rules. |
| Standard `npm run test:db` | Passes 318 sweep cases, 10 registered SQL recipes, 1 pick harness, 4 runner tests, and 33 invalid-setting controls. |
| Former bug recipes | All 3 pass as fixed behavior. The known-bug list is empty. |
| Combined trade guard recipes | 151 assertions pass: 51 lock checks, 45 legality checks, and 55 incoming-destination checks. |
| Hint drain | 10 checks pass. Lock contention ends in 275.01 ms. An overlapping run returns in 35.46 ms. |
| Deferred league versions | 17 checks pass, including conflict rollback and one eventual publication. |
| Draft-only logical publication | 1 changed draft row, 1 total published row, and 1,368 bytes. A league update produces no published row. |
| Ordered private upgrade | 628 migrations at the supplied head become 674 through `20261207000100`. |
| Cron replay | Repeating migration `20261201000200` preserves job IDs, count, schedules, and commands against the supplied live definitions. |
| Fresh versus upgrade | All 4 generated files match byte for byte after a fresh 674-migration install. |
| Generated artifacts | All 4 regenerate on the mini. Catalog contains 530 functions; the approved history range contains 345 migrations. |
| `check:db-function-catalog` and `check:database-types` | Both pass against the upgraded private database. |
| Migration collisions | 0. All 46 added versions remain unchanged. |
| Full Vitest suite | Deferred by the latest instruction until before a push. No push occurs. |

The earlier full Vitest run records 4,391 passed, 69 failed, and 46 skipped.
Focused runs fix its reproduced failures. This checkpoint does not claim a later full-suite pass.

## Browser evidence

The integrated browser build uses source `14564192ea21389ab5d1c7c118f20f8a02ed8ee3`.
The final evidence-only commit changes no application, database, or test source.
The run uses synthetic fixtures and a temporary certificate. It restores no backup.
The receipt records `cleanup: true` and `stage: stopped`.
No container remains for the private project.

The local receipt is `/tmp/fable-r27-lab/closure-verification.json`.
Screenshots include the locked lineup and trade block screen.
The screen review confirms the lock notice, disabled automatic control, and visible player averages.
The 56-case result does not assert the full performance matrix or an installed iPhone session.
The historical ranked baseline stays unchanged.

## Merge order

| Step | Requested commit | Integration commit |
| --- | --- | --- |
| Database probes | `0a9ef307` | `1b18825c` |
| Retained SQL recipes | `742e7be2` | `c023890e` |
| Trade receipt membership | `2030485d` | `8a69a9a2` |
| Trade review pick labels | `0bc2c01c` | `567d1868` |
| Trade legality | `2ec019d1` | `c3569055` |
| Pending asset locks | `78f25784` | `1382ddbc` |
| Offer refresh state | `aa80ff8d` | `fac5c1ba` |
| Performance lab | `19684bb1` | `0b10afb5` |
| Database closure | `7eadd365` | `dba9e8e7` |
| Lineup controls | `483f11d1` | `4e64cbee` |
| Trade block averages | `35624d09` | `6af1fca0` |

## Reproduced integration defects

- The partition migration loses authenticated column grants. It now captures and restores column grants with table grants and policies.
- The version coverage scan misses partitioned parents. It now includes them and rejects a disabled event capture trigger.
- A direct cron table update fails for the migration role. The migration now uses `cron.alter_job` and keeps the supplied guard limits.
- The waiver worker misses the HTTP-compatible trade capacity code. It now records a failed roster claim without consuming the acquisition.
- Invalid structured trade errors produce an invalid HTTP status. They now return HTTP 409 and retain worker handling.
- Trade execution needs a private acquisition proof for each player transfer. Ordinary writes retain asset locks.
- Stored notification cleanup SQL loses scoped lineup checks. The deferred SQL now keeps those checks.
- Backup-dependent SQL tests fail on an empty private stack. They now seed synthetic rows and roll them back.
- Live Edge tests inherit mocked URLs from other tests. Separate processes now preserve the assigned live target.
- The lab trade fixture mocks the retired SQL reader. It now supplies the merged JSON pick reader.
- Three SQL target guards return success without running assertions. They now use the assigned port and raise an explicit error.
- The storage assertion expects an older analysis threshold. It now checks the final analysis policy.

The three former bug recipes fail on the unchanged 628-migration baseline.
They pass in the integrated retained sweep.
The offer refresh negative control fails two cases before its fix.
The runner negative controls reject new failing recipes, wrong bug errors, and a regressed fixed recipe.

## Scope and limits

The final scheduler retains Hashtag rankings, missing-stat reconciliation, daily analysis, and dispatcher-owned public-read retention.
The retained read prune removes its separate cron job, reducing active jobs from four to three.
Both minute workers keep session overlap guards, statement limits, and lock limits.
The roster guard requires the saved executor context and private transaction proof for saved trade moves.
The private mini project is `pt4bafabler27`. Its port block is `600xx`.
The generated schema files come from that database. No generated file receives a manual edit.
Synthetic plan fixtures do not establish production-scale latency or growth.
No installed iPhone PWA, live provider fetch, mail delivery, push delivery, production rollout, or rollback occurs.

## Reproduction commands

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node --test scripts/season-sim/*.test.mjs
node --test tests/db/*.test.mjs
npm run check:quality
```

Run database and Edge commands on the assigned mini after loading its private local stack environment.
The checkpoint recipe uses `bin/pg_dump` in that folder to call the installed dump tool inside its own database container.

```sh
export PATH="$HOME/pancake-t_4ba51e0d/lanes/fable-r27/bin:$HOME/pancake-local/tools:$PATH"
node ../local-run.mjs npm run test:db
PARTITION_DB_TESTS=1 node --test tests/db/checkpoint-partitions.test.mjs tests/db/health-clock.test.mjs tests/db/partition-domain-concurrency.test.mjs tests/db/partition-identity-concurrency.test.mjs
node tests/db/hint-drain-timeouts.mjs
node tests/db/league-version-deferred.mjs
node ../local-run.mjs npm run check:edge-functions
npm run generate:db-function-catalog
npm run generate:database-types
node scripts/regenerate-release-history-attestations.mjs
npm run check:db-function-catalog
npm run check:database-types
```

The [release contract](../supabase/RELEASE-DB.md#release-27) lists every migration, changed Edge function, rollout step, and rollback rule.
The [lab command](perf-lab.md#integration-checks) runs WebKit on the mini with synthetic fixtures and a temporary local certificate.

## Generated file digests

| File | SHA-256 |
| --- | --- |
| `supabase/sql/function-catalog.json` | `e475a72ecafaa692fbb9cfaaebade60a3e6c408a8f00f44231a5469ee80a244c` |
| `types/database.ts` | `cd293085a8318a65febafa5dedad5c72b6928fcd9454666bd00aa195f2394bd8` |
| `tests/e2e/db-security-catalog-attestations.json` | `52bca61774d69eec0bde2957990ea55c297bdcf674d1e8c90300f30f645c86d5` |
| `tests/e2e/release-history-attestations.json` | `183f79f757603cccd80709e8987eef35c89313f7985117599ef11b98979f10de` |

## Every changed file

636 file paths change against `origin/main`: 341 added, 18 deleted, 277 modified.
Renames appear as an old deleted path and a new added path.

| Status | File |
| --- | --- |
| M | `app/(modals)/claim-player.tsx` |
| M | `app/(modals)/lineup.tsx` |
| M | `app/(modals)/propose-trade.tsx` |
| M | `app/(tabs)/draft.tsx` |
| M | `app/(tabs)/index.tsx` |
| M | `app/(tabs)/roster.tsx` |
| M | `app/(tabs)/trades.tsx` |
| M | `components/AutoSetModal.tsx` |
| M | `components/league/LeagueActivityFeed.tsx` |
| A | `components/roster/LockedAssetNotice.tsx` |
| M | `components/roster/RosterItems.tsx` |
| M | `components/roster/RosterPlayerSheet.tsx` |
| M | `components/trades/MultiTeamTradeBuilder.tsx` |
| M | `components/trades/MultiTeamTradeOverview.tsx` |
| M | `components/trades/ParticipantTradePanel.tsx` |
| M | `components/trades/PendingTradeRosterPlan.tsx` |
| M | `components/trades/TradeAnalyzer.tsx` |
| M | `components/trades/TradeAssetColumn.tsx` |
| M | `components/trades/TradeCard.tsx` |
| M | `components/trades/TradeDetailsPanel.tsx` |
| A | `components/trades/TradePickLabel.tsx` |
| A | `components/trades/TradeReviewCancellation.tsx` |
| M | `components/trades/TradeRosterPlanEditor.tsx` |
| M | `components/trades/TradeRosterPreviewList.tsx` |
| M | `components/trades/acceptance-summary.ts` |
| M | `components/ui/LineupControls.tsx` |
| M | `components/ui/Page.tsx` |
| M | `core/cjs/season/schedule.js` |
| M | `core/src/season/schedule.ts` |
| M | `core/tests/calendar.test.ts` |
| A | `docs/data-flow.md` |
| A | `docs/db-capacity.md` |
| M | `docs/db-health.md` |
| M | `docs/interface-design.md` |
| M | `docs/io-audit.md` |
| A | `docs/perf-lab.md` |
| A | `docs/player-identity.md` |
| M | `docs/production-migration-history.md` |
| A | `docs/release-2.7-integration.md` |
| M | `docs/roster-lifecycle.md` |
| A | `docs/screen-matrix.md` |
| A | `docs/trade-legality-verification.md` |
| A | `docs/trade-legality.md` |
| A | `docs/trade-receipts.md` |
| M | `docs/verification.md` |
| A | `docs/work-queue-probe-repairs.md` |
| M | `hooks/use-draft-room-launcher.ts` |
| M | `hooks/use-lineup-actions.ts` |
| M | `hooks/use-player-screen-data.ts` |
| M | `hooks/use-trade-block.ts` |
| M | `hooks/use-trade-history-feed.ts` |
| M | `hooks/use-trade-view-page.ts` |
| M | `hooks/use-trades-feed.ts` |
| M | `knip.json` |
| M | `lib/cache/screen-cache.ts` |
| M | `lib/cache/view-types.ts` |
| M | `lib/lineup.ts` |
| D | `lib/lineup/autoSet.ts` |
| A | `lib/locked-assets.ts` |
| M | `lib/shared/api.ts` |
| M | `lib/trade-composer-draft.ts` |
| M | `lib/trade-composer.ts` |
| M | `lib/trade-legality-step.ts` |
| A | `lib/trade-legality.ts` |
| A | `lib/trade-pick-label.ts` |
| M | `lib/trade-roster-preview.ts` |
| M | `lib/trades.ts` |
| M | `lib/transactions.ts` |
| M | `package.json` |
| M | `public/sw.js` |
| M | `scripts/check-edge-functions.mjs` |
| A | `scripts/db-health/bounded-capture.mjs` |
| A | `scripts/db-health/compact-plans.mjs` |
| A | `scripts/db-health/index-candidates.sql` |
| A | `scripts/db-health/index.mjs` |
| A | `scripts/db-health/pancake` |
| A | `scripts/db-health/pancake.mjs` |
| A | `scripts/db-health/plan-summary.mjs` |
| A | `scripts/db-health/restore-backup.mjs` |
| A | `scripts/db-health/snapshot.sql` |
| A | `scripts/db-health/source-audit.mjs` |
| A | `scripts/db-health/statement-coverage.mjs` |
| A | `scripts/db-tests.mjs` |
| A | `scripts/perf-lab/actions.mjs` |
| A | `scripts/perf-lab/analyzer-test.mjs` |
| A | `scripts/perf-lab/baselines/clock-capture.json` |
| A | `scripts/perf-lab/baselines/closure.json` |
| A | `scripts/perf-lab/baselines/cold-survey.json` |
| A | `scripts/perf-lab/baselines/final-capture.json` |
| A | `scripts/perf-lab/baselines/identity-pairs.json` |
| A | `scripts/perf-lab/baselines/image-transport.json` |
| A | `scripts/perf-lab/baselines/initial-traffic.json` |
| A | `scripts/perf-lab/baselines/normal-cache.json` |
| A | `scripts/perf-lab/baselines/release-cohort.json` |
| A | `scripts/perf-lab/baselines/replay-attempts.json` |
| A | `scripts/perf-lab/baselines/replay-isolation.json` |
| A | `scripts/perf-lab/baselines/replay-runtime.json` |
| A | `scripts/perf-lab/baselines/roster-inputs.json` |
| A | `scripts/perf-lab/baselines/section-content.json` |
| A | `scripts/perf-lab/baselines/verified-reopen.json` |
| A | `scripts/perf-lab/baselines/visual-first-load.json` |
| A | `scripts/perf-lab/baselines/waiver-replay.json` |
| A | `scripts/perf-lab/bounded-log.mjs` |
| A | `scripts/perf-lab/build.mjs` |
| A | `scripts/perf-lab/capture.mjs` |
| A | `scripts/perf-lab/clock-capture.mjs` |
| A | `scripts/perf-lab/closure-test.mjs` |
| A | `scripts/perf-lab/cohort.mjs` |
| A | `scripts/perf-lab/collect.mjs` |
| A | `scripts/perf-lab/common.mjs` |
| A | `scripts/perf-lab/control-observer.mjs` |
| A | `scripts/perf-lab/data-flow-contracts.mjs` |
| A | `scripts/perf-lab/database.mjs` |
| A | `scripts/perf-lab/detached.mjs` |
| A | `scripts/perf-lab/device.mjs` |
| A | `scripts/perf-lab/disk.mjs` |
| A | `scripts/perf-lab/edge-routing.mjs` |
| A | `scripts/perf-lab/edge.mjs` |
| A | `scripts/perf-lab/empty.mjs` |
| A | `scripts/perf-lab/evidence.mjs` |
| A | `scripts/perf-lab/external-headshots.mjs` |
| A | `scripts/perf-lab/gates.mjs` |
| A | `scripts/perf-lab/headshots.mjs` |
| A | `scripts/perf-lab/identity-check.mjs` |
| A | `scripts/perf-lab/identity-diagnostics.mjs` |
| A | `scripts/perf-lab/interactions.mjs` |
| A | `scripts/perf-lab/lab.mjs` |
| A | `scripts/perf-lab/mini.mjs` |
| A | `scripts/perf-lab/network-proxy.mjs` |
| A | `scripts/perf-lab/observer.mjs` |
| A | `scripts/perf-lab/phases.mjs` |
| A | `scripts/perf-lab/player-results.mjs` |
| A | `scripts/perf-lab/postgres-log.mjs` |
| A | `scripts/perf-lab/preflight.mjs` |
| A | `scripts/perf-lab/process.mjs` |
| A | `scripts/perf-lab/provider-gaps.mjs` |
| A | `scripts/perf-lab/regenerate.mjs` |
| A | `scripts/perf-lab/replay-capture.mjs` |
| A | `scripts/perf-lab/replay-evidence.mjs` |
| A | `scripts/perf-lab/replay-runtime.mjs` |
| A | `scripts/perf-lab/report.mjs` |
| A | `scripts/perf-lab/retry-recovery.mjs` |
| A | `scripts/perf-lab/review.mjs` |
| A | `scripts/perf-lab/roster-inputs.mjs` |
| A | `scripts/perf-lab/run.mjs` |
| A | `scripts/perf-lab/runtime.mjs` |
| A | `scripts/perf-lab/scenario-adapters.mjs` |
| A | `scripts/perf-lab/scenarios.json` |
| A | `scripts/perf-lab/screen-baseline.mjs` |
| A | `scripts/perf-lab/selection.mjs` |
| A | `scripts/perf-lab/server-change.mjs` |
| A | `scripts/perf-lab/settle.mjs` |
| A | `scripts/perf-lab/setup.mjs` |
| A | `scripts/perf-lab/surfaces.mjs` |
| A | `scripts/perf-lab/target.mjs` |
| A | `scripts/perf-lab/traffic.mjs` |
| A | `scripts/perf-lab/transfer.mjs` |
| A | `scripts/perf-lab/two-day.mjs` |
| A | `scripts/perf-lab/waiver-diagnostics.mjs` |
| A | `scripts/perf-lab/waiver-plan.mjs` |
| A | `scripts/perf-lab/walk.mjs` |
| A | `scripts/perf-lab/workloads.mjs` |
| M | `scripts/season-sim/README.md` |
| M | `scripts/season-sim/actions.mjs` |
| M | `scripts/season-sim/checkpoints.mjs` |
| M | `scripts/season-sim/checkpoints.test.mjs` |
| A | `scripts/season-sim/cleanup.mjs` |
| A | `scripts/season-sim/cleanup.test.mjs` |
| M | `scripts/season-sim/clock.sql` |
| M | `scripts/season-sim/collect.mjs` |
| M | `scripts/season-sim/common.mjs` |
| M | `scripts/season-sim/common.test.mjs` |
| M | `scripts/season-sim/cron-dispatcher.mjs` |
| M | `scripts/season-sim/cron-dispatcher.test.mjs` |
| M | `scripts/season-sim/cron.test.mjs` |
| A | `scripts/season-sim/database-capture.mjs` |
| A | `scripts/season-sim/database-capture.test.mjs` |
| A | `scripts/season-sim/database-providers.mjs` |
| A | `scripts/season-sim/database-providers.test.mjs` |
| A | `scripts/season-sim/database-rankings.mjs` |
| A | `scripts/season-sim/database-rankings.test.mjs` |
| A | `scripts/season-sim/database-window-contract.mjs` |
| A | `scripts/season-sim/database-window-growth.mjs` |
| A | `scripts/season-sim/database-window-growth.test.mjs` |
| A | `scripts/season-sim/database-window.mjs` |
| A | `scripts/season-sim/database-window.test.mjs` |
| M | `scripts/season-sim/dispatch.mjs` |
| A | `scripts/season-sim/edge-function-inventory.mjs` |
| A | `scripts/season-sim/edge-function-inventory.test.mjs` |
| M | `scripts/season-sim/edge.mjs` |
| M | `scripts/season-sim/index.mjs` |
| M | `scripts/season-sim/input-source.mjs` |
| M | `scripts/season-sim/local-stack.mjs` |
| M | `scripts/season-sim/migration-cron.mjs` |
| M | `scripts/season-sim/migration-cron.test.mjs` |
| M | `scripts/season-sim/next-season.mjs` |
| M | `scripts/season-sim/official-waivers.mjs` |
| M | `scripts/season-sim/origin.mjs` |
| M | `scripts/season-sim/push-origin.mjs` |
| M | `scripts/season-sim/realtime-probe.mjs` |
| M | `scripts/season-sim/realtime-probe.test.mjs` |
| M | `scripts/season-sim/recorder.mjs` |
| M | `scripts/season-sim/replay.mjs` |
| M | `scripts/season-sim/restore-clock.sql` |
| M | `scripts/season-sim/runtime.mjs` |
| M | `scripts/season-sim/trade-scenarios.mjs` |
| A | `scripts/season-sim/trade-scenarios.test.mjs` |
| M | `scripts/season-sim/two-actions.mjs` |
| M | `scripts/season-sim/waiver-oracle.mjs` |
| M | `scripts/season-sim/waiver-oracle.test.mjs` |
| M | `scripts/season-sim/waiver-scenarios.mjs` |
| M | `scripts/season-sim/waiver-scenarios.test.mjs` |
| A | `scripts/season-sim/work-retries.mjs` |
| A | `scripts/season-sim/work-retries.test.mjs` |
| M | `supabase/RELEASE-DB.md` |
| M | `supabase/functions/_shared/apiRuntime.errors.test.ts` |
| M | `supabase/functions/_shared/apiRuntime.ts` |
| M | `supabase/functions/_shared/notificationDraft.test.ts` |
| M | `supabase/functions/_shared/notificationDraft.ts` |
| M | `supabase/functions/_shared/notificationDraftRequest.test.ts` |
| M | `supabase/functions/_shared/schedule.ts` |
| M | `supabase/functions/api/trades.ts` |
| M | `supabase/functions/api/version/realtime.test.ts` |
| M | `supabase/functions/process-trades/activation.test.ts` |
| M | `supabase/functions/sync-players/index.test.ts` |
| M | `supabase/functions/sync-players/index.ts` |
| M | `supabase/functions/sync-players/nbaIds.ts` |
| M | `supabase/functions/sync-players/release.test.ts` |
| A | `supabase/functions/sync-players/rosterIdentity.test.ts` |
| A | `supabase/functions/sync-players/rosterIdentity.ts` |
| A | `supabase/migrations/20261119000100_skip_unchanged_lineup_slots.sql` |
| A | `supabase/migrations/20261119000200_churn_table_storage_policy.sql` |
| A | `supabase/migrations/20261119000300_player_identity_lookup.sql` |
| A | `supabase/migrations/20261119000400_reviewed_player_provider_links.sql` |
| A | `supabase/migrations/20261119000500_reconcile_missing_final_stats.sql` |
| A | `supabase/migrations/20261119000600_provider_write_gate.sql` |
| A | `supabase/migrations/20261119000700_terminal_work_retention.sql` |
| A | `supabase/migrations/20261119000800_application_session_limits.sql` |
| A | `supabase/migrations/20261119000900_schedule_write_gate.sql` |
| A | `supabase/migrations/20261119001000_append_event_time_index.sql` |
| A | `supabase/migrations/20261119001100_preserve_lock_free_stat_resolution.sql` |
| A | `supabase/migrations/20261119001200_preserve_incomplete_season_calendar.sql` |
| A | `supabase/migrations/20261119001300_partition_beacons_and_receipts.sql` |
| A | `supabase/migrations/20261119001400_scope_notification_lineup_checks.sql` |
| A | `supabase/migrations/20261119001500_partition_events_and_invocations.sql` |
| A | `supabase/migrations/20261119001600_complete_public_read_retention.sql` |
| A | `supabase/migrations/20261119001700_refresh_trade_value_statistics.sql` |
| A | `supabase/migrations/20261125000100_partition_player_game_stats.sql` |
| A | `supabase/migrations/20261125000200_partition_notification_outbox.sql` |
| A | `supabase/migrations/20261125000300_restore_missing_final_stats_schedule.sql` |
| A | `supabase/migrations/20261125000400_restore_native_outbox_uniqueness.sql` |
| A | `supabase/migrations/20261125000500_preserve_reconciliation_after_rankings_retirement.sql` |
| A | `supabase/migrations/20261125000600_batch_lineup_notification_claims.sql` |
| A | `supabase/migrations/20261125000700_skip_unchanged_forecast_queue_writes.sql` |
| A | `supabase/migrations/20261125000800_remove_roster_member_prefix_index.sql` |
| A | `supabase/migrations/20261125000900_index_pending_edge_invocations.sql` |
| A | `supabase/migrations/20261126000100_corroborate_null_team_player_identities.sql` |
| A | `supabase/migrations/20261127000100_database_probe_repairs.sql` |
| A | `supabase/migrations/20261201000100_daily_screen_statistics.sql` |
| A | `supabase/migrations/20261201000200_preserve_reconciliation_with_hashtag_rankings.sql` |
| A | `supabase/migrations/20261201000300_reuse_current_forecast_projection_inputs.sql` |
| A | `supabase/migrations/20261201000400_index_recent_score_dispatches.sql` |
| A | `supabase/migrations/20261201000500_share_player_average_refresh_source.sql` |
| A | `supabase/migrations/20261201000600_bound_hint_drain.sql` |
| A | `supabase/migrations/20261201000800_defer_contended_balance_publications.sql` |
| A | `supabase/migrations/20261201000900_draft_only_realtime.sql` |
| A | `supabase/migrations/20261201001000_cap_worker_dispatch.sql` |
| A | `supabase/migrations/20261201001100_player_game_keyset.sql` |
| A | `supabase/migrations/20261201001200_guard_minute_workers.sql` |
| A | `supabase/migrations/20261201001300_separate_forecast_publication.sql` |
| A | `supabase/migrations/20261201001400_gate_idle_screen_refresh.sql` |
| A | `supabase/migrations/20261202000100_authorize_trade_receipt_replays.sql` |
| A | `supabase/migrations/20261204000100_trade_structured_legality.sql` |
| A | `supabase/migrations/20261205000100_pending_asset_locks.sql` |
| A | `supabase/migrations/20261206000100_trade_pick_labels.sql` |
| A | `supabase/migrations/20261207000100_release27_dispatcher_convergence.sql` |
| M | `supabase/sql/function-catalog.json` |
| M | `supabase/sql/functions/by-name/private/accept_trade_participant_atomic.sql` |
| A | `supabase/sql/functions/by-name/private/analyze_screen_table.sql` |
| A | `supabase/sql/functions/by-name/private/analyze_trade_value_rankings.sql` |
| M | `supabase/sql/functions/by-name/private/assert_accepted_trade_capacity.sql` |
| A | `supabase/sql/functions/by-name/private/assert_asset_unlocked.sql` |
| M | `supabase/sql/functions/by-name/private/assert_not_reserved_trade_asset.sql` |
| A | `supabase/sql/functions/by-name/private/check_trade_legality.sql` |
| M | `supabase/sql/functions/by-name/private/create_multi_team_trade_offer.sql` |
| M | `supabase/sql/functions/by-name/private/create_trade_offer.sql` |
| A | `supabase/sql/functions/by-name/private/drop_expired_invocation_partitions.sql` |
| A | `supabase/sql/functions/by-name/private/drop_expired_log_partitions.sql` |
| A | `supabase/sql/functions/by-name/private/enqueue_notifications.sql` |
| M | `supabase/sql/functions/by-name/private/enqueue_scheduled_work.sql` |
| M | `supabase/sql/functions/by-name/private/enqueue_screen_views.sql` |
| A | `supabase/sql/functions/by-name/private/ensure_log_partition.sql` |
| A | `supabase/sql/functions/by-name/private/ensure_player_stats_partition.sql` |
| A | `supabase/sql/functions/by-name/private/flush_deferred_league_versions.sql` |
| M | `supabase/sql/functions/by-name/private/flush_league_inventory_hints.sql` |
| A | `supabase/sql/functions/by-name/private/guard_partition_identity.sql` |
| A | `supabase/sql/functions/by-name/private/guard_player_stats_identity.sql` |
| M | `supabase/sql/functions/by-name/private/guard_trade_plan_reservations.sql` |
| M | `supabase/sql/functions/by-name/private/guard_waiver_plan_reservations.sql` |
| M | `supabase/sql/functions/by-name/private/is_reserved_trade_asset.sql` |
| M | `supabase/sql/functions/by-name/private/league_version_flush.sql` |
| A | `supabase/sql/functions/by-name/private/locked_assets.sql` |
| M | `supabase/sql/functions/by-name/private/notif_is_stale.sql` |
| M | `supabase/sql/functions/by-name/private/notif_lineup_candidates.sql` |
| A | `supabase/sql/functions/by-name/private/notif_lineup_candidates_scoped.sql` |
| M | `supabase/sql/functions/by-name/private/prevent_accepted_or_inactive_roster_move.sql` |
| M | `supabase/sql/functions/by-name/private/prevent_accepted_trade_asset_roster_delete.sql` |
| M | `supabase/sql/functions/by-name/private/prevent_accepted_trade_pick_change.sql` |
| A | `supabase/sql/functions/by-name/private/prevent_locked_lineup_change.sql` |
| A | `supabase/sql/functions/by-name/private/publish_asset_lock_change.sql` |
| A | `supabase/sql/functions/by-name/private/publish_league_version.sql` |
| M | `supabase/sql/functions/by-name/private/queue_matchup_forecasts.sql` |
| A | `supabase/sql/functions/by-name/private/reconcile_missing_final_stats.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_changed_screen_views.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_dispatch_screen_views.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_player_averages.sql` |
| M | `supabase/sql/functions/by-name/private/release_roster_player_to_waivers.sql` |
| M | `supabase/sql/functions/by-name/private/retain_edge_invocations.sql` |
| A | `supabase/sql/functions/by-name/private/retain_league_events.sql` |
| M | `supabase/sql/functions/by-name/private/retain_perf_beacons.sql` |
| A | `supabase/sql/functions/by-name/private/retain_player_game_stats.sql` |
| A | `supabase/sql/functions/by-name/private/retain_public_read_log.sql` |
| M | `supabase/sql/functions/by-name/private/retain_request_receipts.sql` |
| M | `supabase/sql/functions/by-name/private/retain_work_items.sql` |
| A | `supabase/sql/functions/by-name/private/screen_statistics_targets.sql` |
| M | `supabase/sql/functions/by-name/private/trade_resulting_roster.sql` |
| M | `supabase/sql/functions/by-name/private/validate_trade_rosters.sql` |
| M | `supabase/sql/functions/by-name/private/validate_waiver_claim_drop_player.sql` |
| M | `supabase/sql/functions/by-name/private/work_claim.sql` |
| M | `supabase/sql/functions/by-name/private/work_execute.sql` |
| M | `supabase/sql/functions/by-name/public/auto_set_lineup_atomic_unchecked.sql` |
| M | `supabase/sql/functions/by-name/public/claim_notification_outbox_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/complete_accepted_trade_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/dispatch_work.sql` |
| A | `supabase/sql/functions/by-name/public/enqueue_rookie_pick_notification.sql` |
| M | `supabase/sql/functions/by-name/public/get_league_activity_feed.sql` |
| M | `supabase/sql/functions/by-name/public/get_trade_roster_preview.sql` |
| A | `supabase/sql/functions/by-name/public/hold_trade_for_legality_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/link_player_sources_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/prepare_matchup_forecast_inputs.sql` |
| A | `supabase/sql/functions/by-name/public/preview_trade_legality.sql` |
| M | `supabase/sql/functions/by-name/public/process_due_accepted_trades_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/process_next_waiver_claim_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/public_prune_read_log.sql` |
| M | `supabase/sql/functions/by-name/public/public_read.sql` |
| M | `supabase/sql/functions/by-name/public/publish_nba_schedule_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/resolve_player_imports_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/set_trade_roster_plan_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/submit_trade_offer_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/toggle_ir_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/toggle_taxi_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/update_lineup_slots_atomic_unchecked.sql` |
| M | `supabase/sql/functions/by-name/public/view_activity.sql` |
| M | `supabase/sql/functions/by-name/public/view_claim_editor.sql` |
| M | `supabase/sql/functions/by-name/public/view_claims.sql` |
| M | `supabase/sql/functions/by-name/public/view_context.sql` |
| M | `supabase/sql/functions/by-name/public/view_lineup.sql` |
| M | `supabase/sql/functions/by-name/public/view_player.sql` |
| M | `supabase/sql/functions/by-name/public/view_refresh_work.sql` |
| M | `supabase/sql/functions/by-name/public/view_roster.sql` |
| M | `supabase/sql/functions/by-name/public/withdraw_trade_atomic.sql` |
| A | `supabase/sql/index-audit.sql` |
| M | `tests/app/auto-set-labels.test.ts` |
| M | `tests/app/home-slot-capacity.test.ts` |
| M | `tests/app/lineup-empty-slots.test.ts` |
| M | `tests/app/lineup-optimizer-lifetime.test.ts` |
| M | `tests/app/propose-trade-ownership.test.ts` |
| M | `tests/app/roster-empty-slots.test.ts` |
| M | `tests/components/pick-labels.test.ts` |
| A | `tests/components/trades/offer-refresh.test.ts` |
| A | `tests/components/trades/pick-label-parity.test.ts` |
| A | `tests/db/TRIAGE.md` |
| A | `tests/db/benchmark-fixture.sql` |
| A | `tests/db/bounded-capture.test.mjs` |
| A | `tests/db/calendar-completeness.test.ts` |
| A | `tests/db/checkpoint-partitions.test.mjs` |
| A | `tests/db/compact-plans.test.mjs` |
| D | `tests/db/correlated-dispatch.sql` |
| D | `tests/db/cron-dispatch-catchup.sql` |
| M | `tests/db/deadline-locks.sql` |
| M | `tests/db/draft-timer-behavior.sql` |
| M | `tests/db/dynasty-rules.sql` |
| A | `tests/db/edge-invocation-pending-plan.sql` |
| A | `tests/db/excellence-calendar-completeness.sql` |
| A | `tests/db/excellence-event-brin.sql` |
| A | `tests/db/excellence-event-partitions.sql` |
| A | `tests/db/excellence-event-plans.sql` |
| A | `tests/db/excellence-fixture.sql` |
| A | `tests/db/excellence-identity-benchmark.sql` |
| A | `tests/db/excellence-invocation-retention-plan.sql` |
| A | `tests/db/excellence-log-partitions.sql` |
| A | `tests/db/excellence-missing-final-stats.sql` |
| A | `tests/db/excellence-notification-lineup-plan.sql` |
| A | `tests/db/excellence-outbox-storage.sql` |
| A | `tests/db/excellence-partition-retention-plan.sql` |
| A | `tests/db/excellence-player-link-timing.sql` |
| A | `tests/db/excellence-provider-write-gate.sql` |
| A | `tests/db/excellence-public-read-plans.sql` |
| A | `tests/db/excellence-public-read-retention.sql` |
| A | `tests/db/excellence-reconciliation-schedule.sql` |
| A | `tests/db/excellence-replay-recipient-assets.sql` |
| A | `tests/db/excellence-reviewed-player-links.sql` |
| A | `tests/db/excellence-role-limits.sql` |
| A | `tests/db/excellence-schedule-write-gate.sql` |
| A | `tests/db/excellence-screen-walk.sql` |
| A | `tests/db/excellence-slot-idempotence.sql` |
| A | `tests/db/excellence-stats-partitions.sql` |
| A | `tests/db/excellence-storage-policy.sql` |
| A | `tests/db/excellence-terminal-retention.sql` |
| A | `tests/db/excellence-trade-statistics-plan.sql` |
| A | `tests/db/excellence-trade-statistics.sql` |
| A | `tests/db/forecast-input-write-gate.sql` |
| A | `tests/db/forecast-queue-write-gate.sql` |
| A | `tests/db/health-cli.test.mjs` |
| A | `tests/db/health-clock.test.mjs` |
| A | `tests/db/health-report.test.mjs` |
| A | `tests/db/hint-cron-policy.test.mjs` |
| A | `tests/db/hint-drain-timeouts.mjs` |
| M | `tests/db/hygiene-realtime.sql` |
| D | `tests/db/internal-scheduling-rls.sql` |
| M | `tests/db/io-write-reductions.sql` |
| A | `tests/db/known-bugs.json` |
| M | `tests/db/league-events-outcomes.sql` |
| M | `tests/db/league-version-coverage.sql` |
| A | `tests/db/league-version-deferred.mjs` |
| A | `tests/db/league-version-events.sql` |
| M | `tests/db/league-version-transaction-writes.sql` |
| M | `tests/db/league-version-writes.sql` |
| D | `tests/db/live-ingestion-work.sql` |
| M | `tests/db/matchup-forecast-cache-parity.sql` |
| M | `tests/db/notif-announcement-history.sql` |
| M | `tests/db/notif-draft-transitions.sql` |
| M | `tests/db/notif-pause-window.sql` |
| M | `tests/db/notif-producers.sql` |
| A | `tests/db/notification-claim-batching.sql` |
| A | `tests/db/notification-draft-enqueue.test.ts` |
| M | `tests/db/notification-waiver-outbox.sql` |
| M | `tests/db/notification-web-push-requeue.sql` |
| A | `tests/db/partition-domain-concurrency.test.mjs` |
| A | `tests/db/partition-identity-concurrency.test.mjs` |
| A | `tests/db/partition-identity-isolation.sql` |
| A | `tests/db/pending-asset-locks.sql` |
| D | `tests/db/per-minute-cron-gates.sql` |
| M | `tests/db/perf-beacons-validation.sql` |
| M | `tests/db/pg-net-response-vacuum.sql` |
| M | `tests/db/pick-draft-year.sql` |
| M | `tests/db/picks-lifecycle.sql` |
| A | `tests/db/plan-summary.test.mjs` |
| A | `tests/db/player-average-refresh.sql` |
| A | `tests/db/player-game-keyset.sql` |
| M | `tests/db/player-source-connectivity.sql` |
| D | `tests/db/pre-tipoff-lineups.sql` |
| D | `tests/db/process-trades-gate.sql` |
| D | `tests/db/projection-sync-schedule.sql` |
| M | `tests/db/public-cli.sql` |
| A | `tests/db/public-read-retention-queue.sql` |
| A | `tests/db/realtime-draft-publication.mjs` |
| M | `tests/db/refresh-screen-cache.sql` |
| A | `tests/db/regressions/dispatcher-cron-ownership.sql` |
| A | `tests/db/regressions/league-event-version.sql` |
| A | `tests/db/regressions/trade-receipt-former-owner.sql` |
| M | `tests/db/release2-standings-dispatch.sql` |
| M | `tests/db/release2-trade-accept-capacity.sql` |
| M | `tests/db/release25-values-and-schedules.sql` |
| A | `tests/db/restore-backup.test.mjs` |
| M | `tests/db/retention-daily.sql` |
| M | `tests/db/retention-pruning.sql` |
| M | `tests/db/retention-queue.sql` |
| A | `tests/db/reviewed-player-provider-evidence.json` |
| M | `tests/db/rollover-year-gap.sql` |
| D | `tests/db/rookie-drafting-gate.sql` |
| M | `tests/db/roster-lifecycle-invariants.sql` |
| M | `tests/db/roster-lifecycle-oracle.sql` |
| M | `tests/db/rules-faab-reservations.sql` |
| M | `tests/db/rules-recovered-ir-claim-drop.sql` |
| M | `tests/db/rules-reverse-standings-rates.sql` |
| M | `tests/db/rules-support.sql` |
| M | `tests/db/rules-trade-legacy-waiver.sql` |
| M | `tests/db/rules-trade-reservation-message.sql` |
| M | `tests/db/rules-trade-submit-plans.sql` |
| M | `tests/db/rules-trade-waiver-drop.sql` |
| A | `tests/db/runner.test.mjs` |
| A | `tests/db/score-dispatch-plan.sql` |
| A | `tests/db/screen-idle-version-gate.sql` |
| M | `tests/db/screen-publication-versions.sql` |
| M | `tests/db/server-deleted-league-notifications.sql` |
| M | `tests/db/server-game-progress-hints.sql` |
| D | `tests/db/server-injury-schedule.sql` |
| D | `tests/db/server-injury-unavailable.sql` |
| M | `tests/db/server-inventory-hint-cron.sql` |
| M | `tests/db/server-offseason-taxi-activation.sql` |
| M | `tests/db/server-retired-picks.sql` |
| M | `tests/db/server-roster-legality.sql` |
| M | `tests/db/server-stopped-rookie-overflow.sql` |
| M | `tests/db/server-taxi-held-accept.sql` |
| M | `tests/db/server-taxi-unknown-trade.sql` |
| M | `tests/db/server-trade-plan-acceptance.sql` |
| M | `tests/db/server-trade-window.sql` |
| M | `tests/db/simulator-clock-date-defaults.mjs` |
| A | `tests/db/source-audit.test.mjs` |
| A | `tests/db/statement-coverage.test.mjs` |
| A | `tests/db/statistics-maintenance.sql` |
| M | `tests/db/taxi-acquisition-policy.sql` |
| M | `tests/db/taxi-merged-auction-history.sql` |
| M | `tests/db/taxi-trade-queue.sql` |
| M | `tests/db/three-season-simulation.sql` |
| M | `tests/db/timeline-lifecycle.sql` |
| M | `tests/db/timeline-producers.sql` |
| A | `tests/db/trade-block-averages.sql` |
| A | `tests/db/trade-incoming-destinations.sql` |
| M | `tests/db/trade-legality-drops.sql` |
| M | `tests/db/trade-offer-retries.sql` |
| A | `tests/db/trade-pick-labels.sql` |
| M | `tests/db/trade-plan-moves-capacity.sql` |
| A | `tests/db/trade-production-shaped.mjs` |
| M | `tests/db/trade-propose-budget.sql` |
| M | `tests/db/trade-roster-plans.sql` |
| A | `tests/db/trade-structured-legality.sql` |
| M | `tests/db/trade-value-readers.sql` |
| A | `tests/db/trade-values-fixture.sql` |
| M | `tests/db/trade-values.sql` |
| M | `tests/db/waiver-claim-projection.sql` |
| M | `tests/db/waiver-season-matrix.sql` |
| D | `tests/db/weekly-idle-dispatch.sql` |
| D | `tests/db/weekly-idle-load.sql` |
| D | `tests/db/weekly-skip-idle.sql` |
| M | `tests/db/work-queue-lifecycle.sql` |
| M | `tests/db/work-queue-schedules.sql` |
| M | `tests/db/work-queue-views.sql` |
| A | `tests/db/worker-concurrency-bound.sql` |
| M | `tests/db/worker-refresh-bounds.sql` |
| D | `tests/e2e-lineup-auto-set-readiness.test.ts` |
| A | `tests/e2e-trade-offer-stability.test.ts` |
| M | `tests/e2e/README.md` |
| M | `tests/e2e/browser-lineup-gameplay.mjs` |
| M | `tests/e2e/browser-scenario-manifest.mjs` |
| M | `tests/e2e/db-security-catalog-attestations.json` |
| M | `tests/e2e/db-security-catalog.sql` |
| M | `tests/e2e/exact-controls.md` |
| M | `tests/e2e/exact-controls.mjs` |
| A | `tests/e2e/fixtures/pending-asset-locks.sql` |
| A | `tests/e2e/pending-asset-locks.mjs` |
| A | `tests/e2e/perf-lab-globals.d.ts` |
| M | `tests/e2e/release-history-attestations.json` |
| M | `tests/e2e/surface-matrix.json` |
| A | `tests/e2e/trade-block-averages.mjs` |
| A | `tests/e2e/trade-incoming-destinations-webkit.mjs` |
| M | `tests/e2e/trade-legality-browser.mjs` |
| A | `tests/e2e/trade-legality-webkit.mjs` |
| M | `tests/e2e/trade-offer-drop-concurrency-db.mjs` |
| A | `tests/e2e/trade-offer-stability-fixture.sql` |
| A | `tests/e2e/trade-offer-stability.mjs` |
| A | `tests/e2e/trade-pick-backup.mjs` |
| A | `tests/e2e/trade-pick-browser.mjs` |
| A | `tests/e2e/trade-pick-local-setup.mjs` |
| M | `tests/helpers/native-component-mocks.ts` |
| M | `tests/hooks/draft-activity.test.ts` |
| M | `tests/hooks/draft-room-launcher.test.ts` |
| M | `tests/hooks/draft-room-shared-read.test.ts` |
| M | `tests/hooks/league-draft-shared-read.test.ts` |
| M | `tests/hooks/lineup-actions-confirmation.test.ts` |
| M | `tests/hooks/lineup-actions-partial.test.ts` |
| D | `tests/hooks/lineup-auto-set-readiness.test.ts` |
| A | `tests/hooks/player-game-pagination.test.ts` |
| M | `tests/hooks/trade-actions.test.ts` |
| M | `tests/hooks/trade-resource-identity.test.ts` |
| M | `tests/lib/league-tab.test.ts` |
| D | `tests/lib/lineup.test.ts` |
| A | `tests/lib/locked-assets.test.ts` |
| M | `tests/lib/trades-read.test.ts` |
| A | `tests/perf-lab/action-smoke.mjs` |
| A | `tests/perf-lab/adapters.test.ts` |
| A | `tests/perf-lab/analyzer-adapter-smoke.mjs` |
| A | `tests/perf-lab/analyzer-revaluation-cache.test.ts` |
| A | `tests/perf-lab/analyzer-surface.test.ts` |
| A | `tests/perf-lab/auth-probe.mjs` |
| A | `tests/perf-lab/bounded-log-smoke.mjs` |
| A | `tests/perf-lab/bounded-log.test.ts` |
| A | `tests/perf-lab/capture-smoke.mjs` |
| A | `tests/perf-lab/clock-capture.sql` |
| A | `tests/perf-lab/clock-capture.test.ts` |
| A | `tests/perf-lab/cohort.test.ts` |
| A | `tests/perf-lab/content-smoke.mjs` |
| A | `tests/perf-lab/contracts.test.ts` |
| A | `tests/perf-lab/detached.test.ts` |
| A | `tests/perf-lab/disk.test.ts` |
| A | `tests/perf-lab/edge-routing.test.ts` |
| A | `tests/perf-lab/empty.test.ts` |
| A | `tests/perf-lab/external-headshots.test.ts` |
| A | `tests/perf-lab/isolation.test.ts` |
| A | `tests/perf-lab/network-smoke.mjs` |
| A | `tests/perf-lab/player-identities.sql` |
| A | `tests/perf-lab/player-results-smoke.mjs` |
| A | `tests/perf-lab/player-results.test.ts` |
| A | `tests/perf-lab/process.test.ts` |
| A | `tests/perf-lab/replay-evidence.test.ts` |
| A | `tests/perf-lab/replay-runtime.test.ts` |
| A | `tests/perf-lab/report.test.ts` |
| A | `tests/perf-lab/review.test.ts` |
| A | `tests/perf-lab/roster-inputs.test.ts` |
| A | `tests/perf-lab/run-timeout.test.ts` |
| A | `tests/perf-lab/runtime-smoke.mjs` |
| A | `tests/perf-lab/runtime.test.ts` |
| A | `tests/perf-lab/screen-baseline.test.ts` |
| A | `tests/perf-lab/search-smoke.mjs` |
| A | `tests/perf-lab/section-scope.test.ts` |
| A | `tests/perf-lab/selection.test.ts` |
| A | `tests/perf-lab/selector-smoke.mjs` |
| A | `tests/perf-lab/target.test.ts` |
| A | `tests/perf-lab/trade-assets.test.ts` |
| A | `tests/perf-lab/trade-offline.test.ts` |
| A | `tests/perf-lab/trade-preview-read.test.ts` |
| A | `tests/perf-lab/traffic.test.ts` |
| A | `tests/perf-lab/transfer.test.ts` |
| A | `tests/perf-lab/value-contract.test.ts` |
| A | `tests/perf-lab/value-smoke.mjs` |
| A | `tests/perf-lab/waiver-diagnostics.test.ts` |
| A | `tests/perf-lab/waiver-plan.test.ts` |
| A | `tests/perf-lab/web-back-navigation.test.ts` |
| M | `tests/release-edge-compatibility.test.ts` |
| M | `tests/roster-player-actions.test.ts` |
| M | `tests/season-sim-cron.test.ts` |
| M | `tests/service-worker.test.ts` |
| M | `tests/trade-accept-legality.test.ts` |
| M | `tests/trade-analyzer-offline.test.ts` |
| M | `tests/trade-api-routes.test.ts` |
| A | `tests/trade-block-stats.test.ts` |
| M | `tests/trade-legality-step.test.ts` |
| A | `tests/trade-pick-harness.test.ts` |
| A | `tests/trade-pick-label.test.ts` |
| M | `tests/trade-roster-plan.test.ts` |
| M | `tests/trade-taxi-choice.test.ts` |
| M | `tests/ui/design-system.test.ts` |
| M | `tests/ui/shared-layout.test.ts` |
| M | `tsconfig.e2e.json` |
| M | `types/database.ts` |
