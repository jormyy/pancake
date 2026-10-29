# Release 2.7.1 integration

The integration starts from release 2.7 at `f1c1f6ec`.
It merges the watchdog, inactive certification, lineup controls, daily totals, and league schedule in that order.
The supplied production head is `20261209000500`, with 675 migrations.
The private upgrade reaches 679 migrations through `20261210000300`.
All migration versions remain unchanged.
No production service receives a request.

## Initial integration verification

| Check | Result |
| --- | --- |
| Full `npx vitest run` | 4,580 passed, 48 skipped, zero failed; 484 files passed and 16 files skipped. |
| Temporary-file suites | 161 passed across five files. |
| Realtime scan immediately afterward | Six passed, zero failed. |
| Season tests | 346 passed, zero failed. |
| Database harness tests | 51 pure checks and five live partition/clock checks passed; zero failed. |
| `npm run check:quality` | All 13 gates passed. |
| `check:db-function-catalog` | Passed against the private upgraded database. |
| `check:database-types` | Passed against the private upgraded database. |
| Full Edge checks | 554 passed, 12 ignored, zero failed; 16 nested steps passed. 22 entrypoints and 61 evidence entrypoints typecheck. |
| Retained database sweep | 332 passed, zero failed in 125.71 seconds. |
| Database configuration guards | 33 invalid configurations rejected. |
| Pick-window harness | One passed, zero failed. |
| Integrated WebKit checks | 57 passed, zero failed across 41 screen adapters and 16 Analyzer cases. |
| Browser assertion controls | Three valid controls passed; three invalid controls rejected. |

## Repairs

An untracked client fixture reproduces the realtime scan defect before the fix.
The scan now selects only Git-tracked client sources.
The repository scan receives 15 seconds because its full-suite run exceeds the former five-second limit.
Alias, helper, missing-table, extra-table, and unresolved-watch checks remain active.
The client watches 16 tables; Schedule adds no subscription.

The Schedule merge preserves 2.7 player cursors and the existing performance lab.
The integrated lab gains a Schedule surface and checks for the new matchup and lineup controls.
The activity test gains a Schedule component stub.
The report test expects 41 screen surfaces.
The certification fixture accepts the explicitly assigned private port.
The Edge version test expects the active league hint publication from release 2.7.
Its previous zero-row assertion fails against the private database; the corrected assertion passes.
Two database recipes still assume a 3 a.m. Eastern waiver run.
Their first run fails on the current league-midnight behavior near the daylight-saving boundary.
Both now check the first local midnight after the full 48-hour hold.
They retain the previous-midnight rejection check.
One earlier sweep hits a 100-millisecond partition-lock timeout.
That case passes alone, then all 332 cases pass together without a partition code change.
The blocking session is not identified.
Three browser assertion controls pass valid content and reject missing totals, empty schedules, and obsolete lineup periods.
The simulator now accepts the explicitly assigned lab root, project, and port together.
Its new test rejects a different root, project, port, or container.

## Focused database checks

The watchdog recipe passes 49 checks, including its real statement-timeout control.
The Schedule recipe passes 15 checks and returns 3,062 bytes in PostgreSQL JSON text form.
Its plan uses one indexed matchup scan with one loop and 16 rows.
The inactive certification recipe rejects 24 unsafe missing-row cases.
The reconstructed final box certifies 14 players and removes one absent inactive row.

## Generated artifacts

The private project is `pt4bafabler271`, with ports `612xx`.
Cron launch stays disabled during the upgrade and database checks.
An outbound SQL request guard restricts requests to the private port block.
The initial database contains every migration through the supplied production head.
The four candidate migrations then apply in numeric order.
The initial artifacts regenerate from that database.
The maintenance repair regenerates them from a clean upgrade through all 679 migrations.
The generator keeps historical aliases and the recorded security baseline.

| Artifact | SHA-256 |
| --- | --- |
| `supabase/sql/function-catalog.json` | `5719044813852d06096d74955e3fbab0703f6315521009a2d4630234c56b5c14` |
| `types/database.ts` | `cfe007ec717244eb1f76905b97eac925b206b1e418538061b601a0eb408075cb` |
| `tests/e2e/db-security-catalog-attestations.json` | `130fbfbe1efc4c25b8d57efda768c3caeb3e099d67be8bcd7776e8b73c66d1f7` |
| `tests/e2e/release-history-attestations.json` | `ae17c9aaae2fc977f4b23d0be9316e53e4d9cc1429e8d6620b9c8364be155fc8` |

## Commands

```sh
npx vitest run
node --test scripts/season-sim/*.test.mjs
node --test tests/db/*.test.mjs
npm run check:quality
npm run check:edge-functions
node scripts/db-tests.mjs
npm run generate:db-function-catalog
npm run generate:database-types
node scripts/regenerate-release-history-attestations.mjs
npm run check:db-function-catalog
npm run check:database-types
PERF_LAB_LANE=fable-r271 PERF_LAB_PROJECT=pt4bafabler271 PERF_LAB_PORT_PREFIX=612 \
  PERF_LAB_EVIDENCE_ROOT=/tmp/fable-r271-lab PERF_LAB_RESTORE=0 \
  PERF_LAB_TLS_SELF_SIGNED=1 npm run test:perf-lab:closure
```

The interference check runs these commands in this order:

```sh
npx vitest run tests/e2e-release-contracts.test.ts tests/release-script.test.ts tests/release-artifact-recovery.test.ts tests/retain-release-assets.test.ts tests/ios-sim/harness.test.ts
npx vitest run tests/realtime-publication.test.ts
```

Database and Edge commands use the private stack environment.
The browser command runs its build, stack, and WebKit process only on the mini.
[Release contract](../supabase/RELEASE-DB.md#release-271) owns rollout, health thresholds, and rollback.

## Browser and cleanup evidence

The integrated WebKit build uses source `c2982baf2e6c59323f9c7e27e9004f40031b110c`.
The later maintenance repair changes database and verification code.
Its targeted results appear in [statistics isolation evidence](release-2.7.1-statistics-isolation.md).
The closure receipt reports 57 passing cases and zero failures.
Its database receipt reports `cleanup: true` and no cleanup errors.
The private stack stops before the command returns.

The matchup checks verify the Daily Total band between starters and bench.
They check five matchup choices, both arrows, wraparound, the selected date, and the user's matchup first.
The lineup check rejects Today, This week, and ROS controls.
The roster check opens Auto-set and verifies the manual editor option without period controls.
The Schedule check renders 19 synthetic season rows without page overflow.
The separate SQL fixture verifies the complete 20-week result.
The reviewed screenshots show the matchup header, lineup editor, and Schedule tab.

Local receipts and command logs are in `/tmp/fable-r271-evidence`.
The full browser receipt and screenshots are in `/tmp/fable-r271-lab`.
The browser summary is `/tmp/fable-r271-lab/closure-verification.json`.
The private mini evidence stays under `~/pancake-t_4ba51e0d/lanes/fable-r271/`.
Node versions are 22.23.2 on the Mac and 22.23.3 on the mini.

## Maintenance repair

The production timeout report adds migration `20261210000300_isolate_screen_statistics.sql`.
Statistics run in an independent daily cron job; the dispatcher cannot claim retired analysis work.
The repair removes analysis from retention, partition creation, and trade triggers.
The new catalog gate rejects inline ANALYZE, VACUUM, and REINDEX.
The repair uses targeted tests; the next full unit suite is reserved for the requested pre-push check.

## Limits

The full 17,136-case performance matrix is not run.
The standard Vitest run skips 48 optional cases; the Edge command ignores 12 conditional cases.
The five database-dependent Node checks run separately and all pass.
No installed iPhone PWA, live provider fetch, real email, push delivery, production rollout, or production rollback is tested.
No comparative performance gain is claimed.
The earlier transient partition-lock blocker remains unidentified.
No push, pull request, deployment, or CI run occurs.

## Every changed file

The complete release changes 100 files relative to `f1c1f6ec`.

| Change | File |
| --- | --- |
| M | `app/(modals)/matchup.tsx` |
| M | `app/(tabs)/index.tsx` |
| M | `app/(tabs)/league.tsx` |
| M | `components/MatchupLineupView.tsx` |
| M | `components/OtherMatchups.tsx` |
| M | `components/ScoreCard.tsx` |
| A | `components/league/LeagueSchedule.tsx` |
| M | `docs/interface-design.md` |
| A | `docs/live-scoring-inactive-certification.md` |
| A | `docs/operations-scheduler.md` |
| M | `docs/perf-lab.md` |
| M | `docs/production-migration-history.md` |
| A | `docs/release-2.7.1-integration.md` |
| A | `docs/release-2.7.1-statistics-isolation.md` |
| M | `hooks/use-league-screen-state.ts` |
| M | `hooks/use-league-tab-resources.ts` |
| M | `hooks/use-matchup-data.ts` |
| M | `lib/cache/screen-cache.ts` |
| M | `lib/cache/view-types.ts` |
| M | `lib/league/tabs.ts` |
| A | `lib/matchup-daily-total.ts` |
| A | `lib/matchup-navigation.ts` |
| M | `package.json` |
| M | `scripts/check-db-function-sources.mjs` |
| A | `scripts/perf-lab/release-ui.mjs` |
| M | `scripts/perf-lab/surfaces.mjs` |
| M | `scripts/perf-lab/walk.mjs` |
| M | `scripts/perf-lab/workloads.mjs` |
| M | `scripts/season-sim/common.mjs` |
| M | `scripts/season-sim/common.test.mjs` |
| M | `supabase/RELEASE-DB.md` |
| A | `supabase/functions/_shared/syncStats.certification.test.ts` |
| A | `supabase/functions/_shared/syncStats.inactive.test.ts` |
| M | `supabase/functions/_shared/syncStats.ts` |
| M | `supabase/functions/_shared/views.ts` |
| M | `supabase/functions/api/version/realtime.test.ts` |
| A | `supabase/migrations/20261209000600_league_schedule.sql` |
| A | `supabase/migrations/20261210000100_scheduler_watchdog.sql` |
| A | `supabase/migrations/20261210000200_certify_inactive_zero_rows.sql` |
| A | `supabase/migrations/20261210000300_isolate_screen_statistics.sql` |
| M | `supabase/sql/function-catalog.json` |
| D | `supabase/sql/functions/by-name/private/analyze_screen_table.sql` |
| D | `supabase/sql/functions/by-name/private/analyze_trade_value_rankings.sql` |
| A | `supabase/sql/functions/by-name/private/apply_scheduler_health.sql` |
| M | `supabase/sql/functions/by-name/private/ensure_player_stats_partition.sql` |
| A | `supabase/sql/functions/by-name/private/refresh_screen_statistics.sql` |
| M | `supabase/sql/functions/by-name/private/retain_player_game_stats.sql` |
| A | `supabase/sql/functions/by-name/private/scheduler_health.sql` |
| M | `supabase/sql/functions/by-name/private/work_claim.sql` |
| M | `supabase/sql/functions/by-name/private/work_enqueue.sql` |
| M | `supabase/sql/functions/by-name/private/work_execute.sql` |
| M | `supabase/sql/functions/by-name/public/dispatch_work.sql` |
| A | `supabase/sql/functions/by-name/public/get_scheduler_health.sql` |
| M | `supabase/sql/functions/by-name/public/save_game_stats_atomic.sql` |
| A | `supabase/sql/functions/by-name/public/view_league_schedule.sql` |
| M | `tests/app/home-slot-capacity.test.ts` |
| M | `tests/app/league-activity-refresh.test.ts` |
| M | `tests/app/lineup-empty-slots.test.ts` |
| M | `tests/app/lineup-optimizer-lifetime.test.ts` |
| A | `tests/components/league-schedule.test.ts` |
| A | `tests/components/matchup-daily-total.test.ts` |
| M | `tests/components/other-matchups.test.ts` |
| M | `tests/components/score-card-records.test.ts` |
| M | `tests/db/excellence-trade-statistics-plan.sql` |
| M | `tests/db/excellence-trade-statistics.sql` |
| A | `tests/db/league-schedule.sql` |
| A | `tests/db/scheduler-health.sql` |
| A | `tests/db/statistics-catalog-controls.mjs` |
| A | `tests/db/statistics-dispatch-isolation.psql` |
| A | `tests/db/statistics-lock-holder.psql` |
| M | `tests/db/statistics-maintenance.sql` |
| A | `tests/db/statistics-slow-job.psql` |
| A | `tests/db/stats-certification-backup.mjs` |
| A | `tests/db/stats-certification-inactive.sql` |
| M | `tests/db/trade-roster-plans.sql` |
| M | `tests/db/waiver-season-matrix.sql` |
| M | `tests/db/work-queue-lifecycle.sql` |
| M | `tests/e2e/browser-lineup-gameplay.mjs` |
| M | `tests/e2e/db-security-catalog-attestations.json` |
| A | `tests/e2e/matchup-daily-total.mjs` |
| A | `tests/e2e/matchup-navigation.mjs` |
| M | `tests/e2e/release-history-attestations.json` |
| A | `tests/fixtures/league-schedule.json` |
| A | `tests/fixtures/stats-certification/okc-dal.json` |
| M | `tests/helpers/realtime-publication.ts` |
| M | `tests/hooks/league-resource-identity.test.ts` |
| M | `tests/hooks/lineup-actions-partial.test.ts` |
| M | `tests/hooks/other-matchup-cache.test.ts` |
| M | `tests/lib/cache/screen-cache.test.ts` |
| A | `tests/lib/matchup-navigation.test.ts` |
| A | `tests/perf-lab-walk.test.ts` |
| M | `tests/perf-lab/report.test.ts` |
| M | `tests/realtime-publication.test.ts` |
| M | `tests/release-edge-compatibility.test.ts` |
| M | `tests/screen-request-counts.test.ts` |
| M | `tests/shell/league-sections.test.ts` |
| A | `tests/ui/matchup-daily-total.test.ts` |
| A | `tests/ui/matchup-navigation.test.ts` |
| M | `tests/ui/other-matchup-screen.test.ts` |
| M | `types/database.ts` |
