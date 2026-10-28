# Release 2.5 integration evidence

The integration completes locally without production access or deployment.
The source base is release 2.4 at `d267428f`.
The integration starts at `0c681db6`, which already contains the player-sync repair and latest matchup navigation.
All four requested merge targets are present in the required order.
The working changes are committed with `[skip ci]` at each step.

## Result counts

| Check | Observed result |
| --- | --- |
| Full `npx vitest run` | 4,118 passed; 0 failed; 39 skipped; 430 passed files and 14 skipped files. |
| Season simulator tests | 312 passed; 0 failed; 0 skipped. |
| Core tests | 118 passed across 15 files; 0 failed; 0 skipped. |
| Edge checks | 521 passed with 16 steps; 0 failed; 16 ignored. |
| Database behavior | All 28 selected SQL recipes pass on the private stack. |
| `npm run check:quality` | All 13 chained checks pass. |
| `check:db-function-catalog` | Passes against the complete private database. |
| `check:database-types` | Passes against the complete private database. |
| Migration attestation | 621 migrations through `20261123000100`; 292 after the fixed audit anchor. |
| Migration timestamps | 0 collisions across the incoming histories; no renumbered branch migrations. |
| Fresh versus incremental artifacts | 4 of 4 SHA-256 fingerprints match exactly. |
| Release delta | 13 migrations and 10 changed Edge functions against `origin/main`. |
| Files against release base | 272 total: 92 added, 180 modified, 0 deleted. |
| Files changed after integration start | 243 total: 79 added, 164 modified, 0 deleted. |

The 39 skipped Vitest tests and 16 ignored Edge tests remain unexecuted coverage.
This integration does not run a browser release soak or a complete historical replay.
It does not repeat the earlier backup-based CLI or value-reader browser runs.
The production release decision remains separate from this local integration result.

## Completed changes

| Commit | Result |
| --- | --- |
| `bd5fb38c` | Merges player profile sections and game-time loading from `66ae9da6`. |
| `ea346c18` | Merges league-local dates and midnight waivers from `4d58a6a9`. |
| `cd4c0ecd` | Merges public CLI and read routes from `8d0f03f5`. |
| `ac022a95` | Merges stored values from `ac09859e` and reconciles profile and scheduler replacements. |
| `d391cbff` | Repairs reconciliation fixtures and direct hint-drain expectations. |
| `de1d6623` | Repairs absent-value display, timezone expectations, and the waiver mutation catalog. |
| `b7164cf6` | Supplies season test actors and updates the CDN identity-only expectation. |

The final documentation commit contains this report and the aligned release contracts.
The completion response supplies its full SHA.
The generated attestations come from the private database with every repository migration applied.
No generated JSON conflict is merged by hand.

## Reproduced failures and repairs

The original work-queue schedule test fails at `reconciliation retains five-minute cadence` on an empty private database.
The existing scheduler correctly skips idle reconciliation.
The test has no unfinished invocation fixture.
The repair adds idle, unresolved, running, intermediate-minute, and completed cases.
The same recipe also has stale leased hint-work expectations from before the direct SQL drain.
The updated recipe checks its half-minute cron schedule and passes 41 assertions.
No scheduler change is needed for this pre-existing failure.

Two merged migration definitions overwrite other branch behavior.
Source parity detects the scheduler and player-view mismatches.
The combined profile test fails before the final integration migration.
The final migration preserves league-midnight waivers, daily value work, compact profile sections, and stored values in both profile formats.
Its behavior recipe passes eight assertions.
Removing daily value scheduling makes that recipe fail at the daily-schedule assertion.
Removing the compact profile value makes it fail at the stored-value assertion.
Both deliberate changes roll back before the positive checks.

The full Vitest run initially fails two tests.
An empty trade without saved values incorrectly displays `0 vs 0`; it now omits that comparison.
The matchup test expects a time without the new timezone label; its expectation now includes `ET`.
The season mutation catalog targets the retired 03:00 Eastern claim boundary; it now targets league-local midnight.
The quality check finds an unregistered matchup browser recipe; the package now exposes that executable recipe.

The three-season SQL helper starts rookie drafts without its supplied commissioner identity.
It now uses that identity.
The two-season background-worker recipe lacks its service actor; it now supplies that role within its transaction.
The resulting checks pass 13 three-season checkpoints and 16 two-season assertions over 730 simulated dates.
The two-season check starts no Edge invocations.
The Edge suite also finds one stale expected identity-import payload; it now includes `identity_only: true`.

## Database and source evidence

The private project is `pt4bafabler25`, with the API at port `58221` and database at port `58222`.
Cron launch stays disabled before any migration runs, including the fresh rebuild.
The full migration history has 621 distinct ordered versions.
The fixed audit anchor and recorded release 1 security baseline remain unchanged.

The fresh installation and incremental upgrade match these four generated files:

- `tests/e2e/db-security-catalog-attestations.json`
- `tests/e2e/release-history-attestations.json`
- `supabase/sql/function-catalog.json`
- `types/database.ts`

The recorded value fixture supplies 2,618 local player identities.
Publication stores all 450 source players: 445 matched and five pending review.
It stores 18 source picks and nine derived third-round values.
The source parser and publisher use recorded input without an external source request.
The value SQL recipe passes 19 assertions; the reader recipe passes six.
The public CLI SQL recipe uses a temporary synthetic league and rolls back its data and tokens.

The exact SQL recipe set is:

- `tests/db/continuous-faab-schedule.sql`
- `tests/db/continuous-faab.sql`
- `tests/db/edge-invocation-reconcile.sql`
- `tests/db/edge-invocation-response-window.sql`
- `tests/db/forever-two-seasons.sql`
- `tests/db/io-write-reductions.sql`
- `tests/db/league-local-view-day.sql`
- `tests/db/league-midnight-waivers.sql`
- `tests/db/league-season-rules.sql`
- `tests/db/player-age-views.sql`
- `tests/db/player-imports.sql`
- `tests/db/player-link-timing.sql`
- `tests/db/player-profile-sections.sql`
- `tests/db/players-dynasty-sort.sql`
- `tests/db/public-cli.sql`
- `tests/db/release25-values-and-schedules.sql`
- `tests/db/rules-offseason-ir-activation.sql`
- `tests/db/rules-season-trade-rollover.sql`
- `tests/db/rules-waiver-midnight.sql`
- `tests/db/stat-player-resolution.sql`
- `tests/db/three-season-simulation.sql`
- `tests/db/trade-value-readers.sql`
- `tests/db/trade-values.sql`
- `tests/db/waiver-dst-boundaries.sql`
- `tests/db/waiver-run-clearance.sql`
- `tests/db/waiver-season-matrix.sql`
- `tests/db/waiver-timezone-change.sql`
- `tests/db/work-queue-schedules.sql`

The Edge deployment set is derived from the release runner import graph:

- `api`
- `backfill`
- `live-poll`
- `process-waivers`
- `refresh-views`
- `season-boundary`
- `sync-players`
- `sync-scores`
- `sync-stats`
- `sync-trade-values`

[Release contract](../supabase/RELEASE-DB.md) owns the ordered migrations and rollout sequence.
[Production migration history](production-migration-history.md#release-25-candidate) owns the recorded approval range.
The local evidence logs remain outside the repository at `/tmp/pancake-r25-evidence/`.

## Every changed file

This list compares the complete release against `origin/main` at `d267428f`.
It includes the previously merged work and this report.
`A` means added; `M` means modified.

| Change | File |
| --- | --- |
| M | `README.md` |
| M | `app/(modals)/claim-player.tsx` |
| M | `app/(modals)/commissioner-settings.tsx` |
| M | `app/(modals)/lineup.tsx` |
| M | `app/(modals)/matchup.tsx` |
| M | `app/(tabs)/index.tsx` |
| M | `app/(tabs)/players.tsx` |
| M | `app/(tabs)/roster.tsx` |
| M | `app/player/[id].tsx` |
| M | `components/DaySelector.tsx` |
| M | `components/HomeAnnouncementBanner.tsx` |
| M | `components/PlayerSearchItem.tsx` |
| M | `components/WeekOffNotice.tsx` |
| M | `components/dynasty/DynastyHub.tsx` |
| M | `components/home/DailyWaivers.tsx` |
| M | `components/league/LeagueActivityFeed.tsx` |
| M | `components/league/MockRoomsPanel.tsx` |
| M | `components/league/draft-room/AuctionDraftSidePanel.tsx` |
| M | `components/league/draft-room/AuctionIdlePanel.tsx` |
| M | `components/league/draft-room/AuctionLivePanel.tsx` |
| M | `components/player/GameLogTable.tsx` |
| M | `components/player/NextProjectionCard.tsx` |
| M | `components/player/PlayerHeader.tsx` |
| A | `components/player/PlayerSection.tsx` |
| M | `components/player/TransactionHistory.tsx` |
| M | `components/roster/RosterItems.tsx` |
| M | `components/timeline/TeamTimelineScreen.tsx` |
| M | `components/timeline/TimelineScreen.tsx` |
| M | `components/trades/MultiTeamTradeBuilder.tsx` |
| M | `components/trades/SavedTradeEstimate.tsx` |
| M | `components/trades/TradeAnalysisSummary.tsx` |
| M | `components/trades/TradeCard.tsx` |
| M | `components/trades/TradeDetailsPanel.tsx` |
| M | `components/waivers/WaiversSection.tsx` |
| M | `core/cjs/dynasty/decisionEngine.js` |
| M | `core/src/dynasty/decisionEngine.ts` |
| M | `docs/interface-design.md` |
| M | `docs/production-migration-history.md` |
| A | `docs/public-cli.md` |
| A | `docs/release-2.5-integration.md` |
| M | `docs/release-history-attestations.md` |
| M | `docs/roster-lifecycle.md` |
| A | `docs/trade-values.md` |
| M | `hooks/use-commissioner-admin-actions.ts` |
| M | `hooks/use-commissioner-settings-resource.ts` |
| M | `hooks/use-dynasty-rankings.ts` |
| A | `hooks/use-league-day.ts` |
| M | `hooks/use-league-draft-controller.ts` |
| A | `hooks/use-league-timezone.ts` |
| M | `hooks/use-lineup-actions.ts` |
| M | `hooks/use-live-stats.ts` |
| M | `hooks/use-matchup-data.ts` |
| M | `hooks/use-matchup-game-times.ts` |
| M | `hooks/use-mock-rooms-controller.ts` |
| M | `hooks/use-player-screen-data.ts` |
| M | `hooks/use-player-search.ts` |
| M | `hooks/use-screen-view.ts` |
| M | `lib/cache/screen-cache.ts` |
| M | `lib/cache/screen-scope.ts` |
| M | `lib/cache/view-types.ts` |
| M | `lib/commissioner-settings-draft.ts` |
| M | `lib/draft-display.ts` |
| M | `lib/dynasty-decisions.ts` |
| M | `lib/format.ts` |
| M | `lib/games.ts` |
| M | `lib/league-daily-cache.ts` |
| A | `lib/league-timezones.ts` |
| M | `lib/league.ts` |
| M | `lib/lineup/autoSet.ts` |
| M | `lib/lineup/read.ts` |
| M | `lib/lineup/snapshot.ts` |
| M | `lib/pickup.ts` |
| M | `lib/player-availability.ts` |
| M | `lib/player-search-sort.ts` |
| M | `lib/players.ts` |
| M | `lib/roster-add-flow.ts` |
| M | `lib/scoring.ts` |
| M | `lib/shared/dates.ts` |
| M | `lib/shared/week.ts` |
| M | `lib/tab-snapshot.ts` |
| M | `lib/timeline.ts` |
| M | `lib/timezone.ts` |
| M | `lib/trade-estimates.ts` |
| M | `lib/trades.ts` |
| M | `lib/waivers.ts` |
| M | `package.json` |
| A | `packages/pancake-cli/README.md` |
| A | `packages/pancake-cli/bin/pancake.mjs` |
| A | `packages/pancake-cli/package.json` |
| A | `packages/pancake-cli/schemas/v1.json` |
| M | `scripts/mutation/waivers/build_catalog.py` |
| M | `scripts/mutation/waivers/catalog.json` |
| M | `scripts/season-sim/edge.mjs` |
| M | `scripts/season-sim/mutation-catalog.test.mjs` |
| A | `scripts/season-sim/trade-value-catalog.mjs` |
| M | `supabase/RELEASE-DB.md` |
| M | `supabase/config.toml` |
| M | `supabase/functions/_shared/cdnBatch.test.ts` |
| M | `supabase/functions/_shared/dynastyEngine.ts` |
| M | `supabase/functions/_shared/playerResolver.test.ts` |
| M | `supabase/functions/_shared/playerResolver.ts` |
| M | `supabase/functions/_shared/syncStats.ts` |
| M | `supabase/functions/_shared/tradeEstimate.ts` |
| A | `supabase/functions/_shared/tradeValues.ts` |
| A | `supabase/functions/api/public/handler.ts` |
| A | `supabase/functions/api/public/index.ts` |
| A | `supabase/functions/api/public/schema.json` |
| M | `supabase/functions/api/router.ts` |
| A | `supabase/functions/api/views/game-times.ts` |
| M | `supabase/functions/api/views/index.ts` |
| M | `supabase/functions/process-waivers/index.ts` |
| A | `supabase/functions/sync-players/backup.test.ts` |
| A | `supabase/functions/sync-players/birthdates.test.ts` |
| A | `supabase/functions/sync-players/birthdates.ts` |
| A | `supabase/functions/sync-players/concurrentStats.test.ts` |
| M | `supabase/functions/sync-players/imports.test.ts` |
| M | `supabase/functions/sync-players/index.test.ts` |
| M | `supabase/functions/sync-players/index.ts` |
| A | `supabase/functions/sync-players/nba-resume.test.ts` |
| M | `supabase/functions/sync-players/nbaIds.ts` |
| A | `supabase/functions/sync-players/nbaLinkPlan.ts` |
| M | `supabase/functions/sync-players/release.test.ts` |
| A | `supabase/functions/sync-players/sleeperDeferral.test.ts` |
| M | `supabase/functions/sync-players/sleeperLinks.ts` |
| A | `supabase/functions/sync-trade-values/index.ts` |
| A | `supabase/migrations/20261117000100_player_link_identity_index.sql` |
| A | `supabase/migrations/20261117000200_stat_player_resolution.sql` |
| A | `supabase/migrations/20261118000100_public_cli.sql` |
| A | `supabase/migrations/20261118000200_public_matchup_state.sql` |
| A | `supabase/migrations/20261118000300_public_stats_seasons.sql` |
| A | `supabase/migrations/20261120000100_onenumber_trade_values.sql` |
| A | `supabase/migrations/20261120000200_trade_value_readers.sql` |
| A | `supabase/migrations/20261120000300_trade_value_cache_refresh.sql` |
| A | `supabase/migrations/20261121000001_league_midnight_waivers.sql` |
| A | `supabase/migrations/20261121000004_reschedule_waivers_timezone.sql` |
| A | `supabase/migrations/20261121000005_league_local_view_day.sql` |
| A | `supabase/migrations/20261122000100_player_views.sql` |
| A | `supabase/migrations/20261123000100_release25_player_values_and_schedule.sql` |
| M | `supabase/sql/function-catalog.json` |
| M | `supabase/sql/functions/by-name/private/build_trade_estimate_inputs.sql` |
| M | `supabase/sql/functions/by-name/private/enqueue_scheduled_work.sql` |
| M | `supabase/sql/functions/by-name/private/next_waiver_run.sql` |
| M | `supabase/sql/functions/by-name/public/cancel_waiver_claim_atomic.sql` |
| A | `supabase/sql/functions/by-name/public/claim_trade_value_sync.sql` |
| M | `supabase/sql/functions/by-name/public/count_due_waiver_claims.sql` |
| M | `supabase/sql/functions/by-name/public/create_waiver_claim_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/edit_waiver_claim_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/get_dynasty_forecast_inputs.sql` |
| A | `supabase/sql/functions/by-name/public/get_dynasty_pick_values.sql` |
| A | `supabase/sql/functions/by-name/public/get_trade_value_sync_state.sql` |
| M | `supabase/sql/functions/by-name/public/link_player_sources_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/process_next_waiver_claim_atomic.sql` |
| A | `supabase/sql/functions/by-name/public/public_prune_read_log.sql` |
| A | `supabase/sql/functions/by-name/public/public_read.sql` |
| A | `supabase/sql/functions/by-name/public/public_share_token.sql` |
| A | `supabase/sql/functions/by-name/public/publish_trade_values.sql` |
| M | `supabase/sql/functions/by-name/public/reorder_waiver_claim_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/resolve_player_imports_atomic.sql` |
| A | `supabase/sql/functions/by-name/public/resolve_trade_value_review.sql` |
| M | `supabase/sql/functions/by-name/public/set_waiver_clears_at.sql` |
| A | `supabase/sql/functions/by-name/public/trade_value_review_overrides.sql` |
| M | `supabase/sql/functions/by-name/public/view_context.sql` |
| M | `supabase/sql/functions/by-name/public/view_player.sql` |
| M | `supabase/sql/functions/by-name/public/view_player_search.sql` |
| M | `supabase/sql/functions/by-name/public/view_players.sql` |
| M | `supabase/sql/functions/by-name/public/view_trade_details.sql` |
| M | `tests/app/commissioner-scoring-settings.test.ts` |
| M | `tests/app/daily-waivers.test.ts` |
| M | `tests/app/home-slot-capacity.test.ts` |
| M | `tests/app/home-surface-week-off.test.ts` |
| M | `tests/app/matchup-row.test.ts` |
| M | `tests/app/roster-empty-slots.test.ts` |
| M | `tests/components/activity-refresh.test.ts` |
| M | `tests/components/home-announcement.test.ts` |
| A | `tests/components/league-time-labels.test.ts` |
| M | `tests/components/matchup-row-layout.test.ts` |
| M | `tests/components/player-eligibility-tags.test.ts` |
| M | `tests/components/player/player-detail.test.ts` |
| M | `tests/components/player/player-screen.test.ts` |
| M | `tests/db/continuous-faab-schedule.sql` |
| M | `tests/db/continuous-faab.sql` |
| M | `tests/db/forever-two-seasons.sql` |
| A | `tests/db/league-local-view-day.sql` |
| A | `tests/db/league-midnight-waivers.sql` |
| M | `tests/db/player-age-views.sql` |
| M | `tests/db/player-imports.sql` |
| A | `tests/db/player-link-timing.sql` |
| A | `tests/db/player-profile-sections.sql` |
| A | `tests/db/players-dynasty-sort.sql` |
| A | `tests/db/public-cli.sql` |
| A | `tests/db/release25-values-and-schedules.sql` |
| M | `tests/db/rules-waiver-midnight.sql` |
| A | `tests/db/stat-player-resolution.sql` |
| M | `tests/db/three-season-simulation.sql` |
| A | `tests/db/trade-value-readers.sql` |
| A | `tests/db/trade-values.sql` |
| M | `tests/db/waiver-dst-boundaries.sql` |
| M | `tests/db/waiver-run-clearance.sql` |
| A | `tests/db/waiver-timezone-change.sql` |
| M | `tests/db/work-queue-schedules.sql` |
| M | `tests/draft-idle-connection.test.ts` |
| M | `tests/draft-live-panel.test.ts` |
| A | `tests/e2e-player-profile-capture.test.ts` |
| A | `tests/e2e/build-trade-value-reader.mjs` |
| M | `tests/e2e/db-security-catalog-attestations.json` |
| A | `tests/e2e/league-timezone-browser.mjs` |
| A | `tests/e2e/other-matchup-navigation.mjs` |
| A | `tests/e2e/player-profile-capture.mjs` |
| A | `tests/e2e/player-profile-fixture.sql` |
| A | `tests/e2e/player-profile-local-setup.mjs` |
| A | `tests/e2e/player-profile-measurement.md` |
| A | `tests/e2e/public-cli.mjs` |
| M | `tests/e2e/release-history-attestations.json` |
| A | `tests/e2e/trade-value-reader-browser.mjs` |
| A | `tests/e2e/trade-value-reader-server.mjs` |
| A | `tests/e2e/trade-value-reader-setup.mjs` |
| A | `tests/e2e/trade-value-stack.test.ts` |
| A | `tests/e2e/trade-values-db.mjs` |
| A | `tests/fixtures/public-cli/league.json` |
| A | `tests/fixtures/trade-values/live-evidence.json` |
| A | `tests/fixtures/trade-values/onenumberhoops.json` |
| A | `tests/fixtures/trade-values/pancake-players.json` |
| A | `tests/fixtures/trade-values/rankings.html` |
| A | `tests/fixtures/trade-values/source.json` |
| M | `tests/hooks/dynasty-rankings-identity.test.ts` |
| M | `tests/hooks/dynasty-rankings-reconnect.test.ts` |
| A | `tests/hooks/league-day-screens.test.ts` |
| M | `tests/hooks/league-draft-controller.test.ts` |
| M | `tests/hooks/lineup-actions-confirmation.test.ts` |
| M | `tests/hooks/lineup-actions-partial.test.ts` |
| M | `tests/hooks/live-stats-polling.test.ts` |
| A | `tests/hooks/matchup-first-paint.test.ts` |
| M | `tests/hooks/matchup-game-times.test.ts` |
| M | `tests/hooks/mock-room-panel.test.ts` |
| M | `tests/hooks/mock-rooms-controller.test.ts` |
| A | `tests/hooks/player-profile-loading.test.ts` |
| M | `tests/hooks/player-screen-activity.test.ts` |
| M | `tests/hooks/player-screen-first-paint.test.ts` |
| M | `tests/hooks/player-search-availability-refresh.test.ts` |
| M | `tests/lib/claim-process-date.test.ts` |
| M | `tests/lib/commissioner-settings-draft.test.ts` |
| A | `tests/lib/league-time-browser-target.test.ts` |
| M | `tests/lib/lineup-context-authority.test.ts` |
| M | `tests/lib/lineup-snapshot.test.ts` |
| M | `tests/lib/lineup.test.ts` |
| M | `tests/lib/pickup.test.ts` |
| M | `tests/lib/player-search-sort.test.ts` |
| M | `tests/lib/player-support-resources.test.ts` |
| M | `tests/lib/timezone.test.ts` |
| M | `tests/list-render-counts.test.ts` |
| M | `tests/loading/header-stability.test.ts` |
| M | `tests/pickup-add-limit-states.test.ts` |
| A | `tests/player-link-plan.test.ts` |
| M | `tests/player-transaction-history-identity.test.ts` |
| A | `tests/public-cli/__snapshots__/public-api.test.ts.snap` |
| A | `tests/public-cli/cli.test.ts` |
| A | `tests/public-cli/public-api.test.ts` |
| M | `tests/release-edge-compatibility.test.ts` |
| M | `tests/roster-claim-presentation.test.ts` |
| M | `tests/shell/mobile-shell.test.ts` |
| M | `tests/trade-builder-layout.test.ts` |
| M | `tests/trade-builder-terms.test.ts` |
| M | `tests/trade-notes-input.test.ts` |
| A | `tests/trade-value-readers.test.ts` |
| A | `tests/trade-values-catalog.test.ts` |
| A | `tests/trade-values-worker.test.ts` |
| A | `tests/trade-values.test.ts` |
| M | `tests/ui/other-matchup-screen.test.ts` |
| M | `tests/ui/polish-details-layout.test.ts` |
| M | `tests/ux-round2.test.ts` |
| A | `tests/views-game-times.test.ts` |
| M | `types/database.ts` |
