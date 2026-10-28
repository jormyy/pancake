# Release 2.4 integration

## Decision

The integration is complete and ready for release review.
All four remaining branches merge in the requested order.
The earlier IO, matchup, trade legality, and architecture changes remain integrated.
No production access, push, or deployment occurs.

## Scope

| Measure | Count |
| --- | ---: |
| Changed files since `c3209ddc` | 224 |
| Modified files | 157 |
| Added files | 67 |
| Repository migrations | 608 |
| Unique migration versions | 608 |
| New migrations since `c3209ddc` | 11 |
| New migrations since `origin/main` at `6ad9b65e` | 12 |
| Migrations after the recorded release 1 baseline | 44 |
| Migrations after the fixed audit baseline | 279 |
| Changed Edge functions against `6ad9b65e` | 21 |
| Cataloged database functions | 486 |

The final migration is `20261116000500`.
The audit baseline stays at 329 migrations through `20261005000003`.
The recorded pre-migration security catalog stays at 564 migrations through `20261029000800`.
[Release database notes](../supabase/RELEASE-DB.md) list every release migration, changed Edge function, and rollout dependency.
[Migration history](production-migration-history.md) records the range and renumbering.

## Merge commits

| Step | Commit |
| --- | --- |
| UI round 3 | `820527eb8656f1c9274c82971049bac0cf3a488a` |
| Live forecast | `f87df0ea08b818d0f6c922085c62d6863ce8d82d` |
| Trade timeout | `a30aa4712808215ab6586e972c7b1706c9702c39` |
| UI round 4 | `583cbbd4344b0da0e164b526c0d3057a28dd7862` |

Each merge commit includes `[skip ci]`.

## Conflict decisions

- Matchup cache identity retains the selected matchup, league timezone, and calendar day.
- League-day refresh remains intact when game times and final-game labels are added.
- The roster editor retains direct slot choices and includes player age metadata.
- League change handling retains transaction-level write coalescing and deferred trade publication.
- Forecast migrations move to `20261115000500` and `20261115000600`.
- Trade migrations move to `20261116000300`, `20261116000400`, and `20261116000500`.
- The generated attestations, function catalog, and database types come from the private database.
- The IO recipes accept the configured loopback database port instead of requiring one fixed port.
- Standalone verification files become explicit dead-code-check entrypoints; the unused draft-age helper is removed.

## Verification

| Check | Final result |
| --- | --- |
| Full `npx vitest run` | 3,960 passed; 0 failed; 38 skipped. |
| Vitest files | 416 passed; 0 failed; 13 skipped. |
| `node --test 'scripts/season-sim/*.test.mjs'` | 312 passed; 0 failed; 0 skipped. |
| `npm run check:quality` | All 13 checks pass, including design-system conformance. |
| Deno recipes within quality | 61 entrypoints checked. |
| Focused Edge runtime tests | 32 passed; 0 failed across 6 files. |
| Focused SQL assertions | 84 passed across 8 files. |
| Forecast cache comparison | Passes with 40 synthetic roster players and historical game data. |
| Trade lock contention | Both settlement modes pass the 1,000 ms limit. |
| IO negative controls | All 13 detect the original faulty behavior. |
| `check:db-function-catalog` | Passes against the final private database. |
| `check:database-types` | Passes against the final private database. |
| Attestation head and source checks | Pass through `20261116000500`. |
| Fresh installation versus incremental upgrade | All four generated files are byte-identical. |
| Migration version uniqueness | 608 of 608 versions are unique. |

The private mini uses project `pt4bafabler24` and database port `59822` within the `598xx` block.
Every migration applies in order on a fresh database.
Scheduled jobs remain disabled on this test stack.
Focused checks run before each merge commit.
The final full run follows repairs to a release-note format mismatch and dead-code findings.
The skipped tests are optional environment-dependent checks; they are not counted as passes.
Browser suites and a production-sized restored-data trade benchmark are not run during this integration.

The database trade probes record these elapsed times:

| Settlement | Propose | Accept | Busy rejection |
| --- | ---: | ---: | ---: |
| Deferred | 25.99 ms | 31.83 ms | 18.41 ms |
| Immediate | 39.19 ms | 485.37 ms | 34.81 ms |

## Reproduced failures

The other-matchup cache test fails when it assumes an Eastern date instead of the selected league date.
The repaired test passes with the integrated league-time behavior.
Stale attestations fail their head checks before database regeneration.
The original database definitions fail all 13 targeted IO controls.
Original cache refreshes write five unchanged rows; the integrated definitions write zero.
The release-note contract detects a changed required heading before the heading is restored.
The quality check detects four unregistered verification files and an unused helper before cleanup.

## Every changed file

This inventory compares the final integration with `c3209ddc`.
`M` means modified; `A` means added.
It includes this report.

| Change | File |
| --- | --- |
| M | `app/(modals)/_layout.tsx` |
| M | `app/(modals)/claim-player.tsx` |
| M | `app/(modals)/draft-room.tsx` |
| M | `app/(modals)/lineup.tsx` |
| A | `app/(modals)/matchup.tsx` |
| M | `app/(modals)/propose-trade.tsx` |
| M | `app/(modals)/rookie-draft-room.tsx` |
| M | `app/(tabs)/index.tsx` |
| M | `app/(tabs)/players.tsx` |
| M | `app/(tabs)/roster.tsx` |
| M | `app/(tabs)/trades.tsx` |
| M | `components/ActivationOverflowModal.tsx` |
| M | `components/Badge.tsx` |
| M | `components/DaySelector.tsx` |
| M | `components/DropPlayerPickerModal.tsx` |
| M | `components/IRResolutionModal.tsx` |
| M | `components/MatchupLineupView.tsx` |
| M | `components/MatchupRow.tsx` |
| A | `components/OtherMatchups.tsx` |
| M | `components/league/LeagueActivityFeed.tsx` |
| M | `components/league/draft-room/AuctionDraftSidePanel.tsx` |
| M | `components/league/draft-room/AuctionIdlePanel.tsx` |
| M | `components/league/draft-room/AuctionLivePanel.tsx` |
| M | `components/league/draft-room/RookiePickRow.tsx` |
| M | `components/player/PlayerEligibilityTags.tsx` |
| M | `components/roster/RosterItems.tsx` |
| M | `components/roster/RosterPlayerSheet.tsx` |
| M | `components/roster/RosterTrimBanner.tsx` |
| M | `components/trades/MultiTeamTradeBuilder.tsx` |
| M | `components/trades/ParticipantTradePanel.tsx` |
| M | `components/trades/PendingTradeRosterPlan.tsx` |
| M | `components/trades/TradeAssetColumn.tsx` |
| M | `components/trades/TradeCard.tsx` |
| M | `components/trades/TradeDetailsPanel.tsx` |
| M | `components/trades/TradeListRow.tsx` |
| M | `components/trades/TradeRosterPlanEditor.tsx` |
| M | `components/trades/TradeRosterPreviewList.tsx` |
| M | `components/trades/acceptance-summary.ts` |
| M | `components/ui/Badge.tsx` |
| M | `components/ui/Page.tsx` |
| M | `components/ui/PlayerRow.tsx` |
| M | `components/ui/useFittedText.ts` |
| M | `components/waivers/WaiversSection.tsx` |
| M | `constants/navigation.ts` |
| A | `docs/io-audit.md` |
| M | `docs/player-sources.md` |
| M | `docs/production-migration-history.md` |
| A | `docs/release-2.4-integration.md` |
| M | `docs/release-history-attestations.md` |
| M | `docs/verification.md` |
| M | `hooks/use-matchup-data.ts` |
| A | `hooks/use-matchup-game-times.ts` |
| A | `hooks/use-player-age.ts` |
| M | `hooks/use-trade-actions.ts` |
| M | `knip.json` |
| M | `lib/draft-display.ts` |
| M | `lib/league.ts` |
| M | `lib/shared/api.ts` |
| M | `lib/timezone.ts` |
| A | `lib/trade-legality-step.ts` |
| M | `package.json` |
| M | `scripts/season-sim/cron.test.mjs` |
| M | `supabase/RELEASE-DB.md` |
| M | `supabase/functions/_shared/playerSource.test.ts` |
| M | `supabase/functions/_shared/playerSource.ts` |
| A | `supabase/functions/_shared/responses.test.ts` |
| M | `supabase/functions/_shared/responses.ts` |
| M | `supabase/functions/_shared/serve.ts` |
| M | `supabase/functions/_shared/syncRuns.ts` |
| M | `supabase/functions/api/router.ts` |
| M | `supabase/functions/api/tradeActivation.test.ts` |
| A | `supabase/functions/api/tradeEstimateWork.test.ts` |
| A | `supabase/functions/api/tradeEstimateWork.ts` |
| M | `supabase/functions/api/tradeEstimates.ts` |
| M | `supabase/functions/api/trades.ts` |
| M | `supabase/functions/api/views/index.ts` |
| A | `supabase/functions/api/views/other-matchup.ts` |
| M | `supabase/functions/lineup-optimizer/preTipoff.test.ts` |
| M | `supabase/functions/lineup-optimizer/preTipoff.ts` |
| M | `supabase/functions/live-poll/scoreboard.test.ts` |
| M | `supabase/functions/live-poll/scoreboard.ts` |
| A | `supabase/functions/matchup-forecast/context.test.ts` |
| A | `supabase/functions/matchup-forecast/context.ts` |
| M | `supabase/functions/matchup-forecast/index.ts` |
| M | `supabase/functions/sync-player-injuries/index.test.ts` |
| A | `supabase/functions/sync-players/ambiguousImports.test.ts` |
| M | `supabase/functions/sync-players/imports.ts` |
| M | `supabase/functions/sync-players/injuries.ts` |
| A | `supabase/migrations/20261115000100_io_idle_and_retention.sql` |
| A | `supabase/migrations/20261115000200_io_screen_content.sql` |
| A | `supabase/migrations/20261115000300_io_coalesce_changes.sql` |
| A | `supabase/migrations/20261115000400_io_live_progress.sql` |
| A | `supabase/migrations/20261115000500_bounded_matchup_forecast_history.sql` |
| A | `supabase/migrations/20261115000600_precomputed_forecast_inputs.sql` |
| A | `supabase/migrations/20261116000100_review_screen_fields.sql` |
| A | `supabase/migrations/20261116000200_exact_player_rosters.sql` |
| A | `supabase/migrations/20261116000300_async_trade_estimates.sql` |
| A | `supabase/migrations/20261116000400_deduplicate_pending_trade_offers.sql` |
| A | `supabase/migrations/20261116000500_defer_trade_publication.sql` |
| M | `supabase/sql/function-catalog.json` |
| M | `supabase/sql/functions/by-name/private/accept_trade_participant_atomic.sql` |
| M | `supabase/sql/functions/by-name/private/assert_trade_window.sql` |
| A | `supabase/sql/functions/by-name/private/attach_submitted_trade_estimate.sql` |
| M | `supabase/sql/functions/by-name/private/attach_trade_estimate.sql` |
| A | `supabase/sql/functions/by-name/private/compute_matchup_forecast_context.sql` |
| M | `supabase/sql/functions/by-name/private/create_multi_team_trade_offer.sql` |
| M | `supabase/sql/functions/by-name/private/create_trade_offer.sql` |
| A | `supabase/sql/functions/by-name/private/defer_trade_event.sql` |
| M | `supabase/sql/functions/by-name/private/emit_league_change.sql` |
| M | `supabase/sql/functions/by-name/private/enqueue_scheduled_work.sql` |
| M | `supabase/sql/functions/by-name/private/enqueue_screen_views.sql` |
| A | `supabase/sql/functions/by-name/private/invalidate_forecast_inputs.sql` |
| M | `supabase/sql/functions/by-name/private/league_version_enqueue.sql` |
| M | `supabase/sql/functions/by-name/private/lock_trade_offer_assets.sql` |
| A | `supabase/sql/functions/by-name/private/matchup_forecast_inputs_ready.sql` |
| A | `supabase/sql/functions/by-name/private/publish_trade_changes.sql` |
| A | `supabase/sql/functions/by-name/private/queue_trade_publication.sql` |
| A | `supabase/sql/functions/by-name/private/read_matchup_forecast_context.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_changed_screen_views.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_dispatch_screen_views.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_matchup_totals.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_player_averages.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_standings.sql` |
| M | `supabase/sql/functions/by-name/private/refresh_trade_values.sql` |
| A | `supabase/sql/functions/by-name/private/repair_player_game_teams.sql` |
| M | `supabase/sql/functions/by-name/private/retain_cron_job_run_details.sql` |
| A | `supabase/sql/functions/by-name/private/update_forecast_season_points.sql` |
| M | `supabase/sql/functions/by-name/private/validate_trade_rosters.sql` |
| M | `supabase/sql/functions/by-name/private/work_enqueue.sql` |
| M | `supabase/sql/functions/by-name/private/work_execute.sql` |
| M | `supabase/sql/functions/by-name/public/complete_accepted_trade_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/dispatch_work.sql` |
| M | `supabase/sql/functions/by-name/public/get_matchup_forecast_context.sql` |
| A | `supabase/sql/functions/by-name/public/get_prepared_matchup_forecast_context.sql` |
| M | `supabase/sql/functions/by-name/public/link_player_sources_atomic.sql` |
| A | `supabase/sql/functions/by-name/public/prepare_matchup_forecast_inputs.sql` |
| M | `supabase/sql/functions/by-name/public/prevent_trade_acceptance_after_deadline.sql` |
| M | `supabase/sql/functions/by-name/public/resolve_player_imports_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/save_live_game_stats_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/save_live_scoreboard_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/set_trade_roster_plan_atomic.sql` |
| M | `supabase/sql/functions/by-name/public/view_context.sql` |
| M | `supabase/sql/functions/by-name/public/view_home.sql` |
| M | `supabase/sql/functions/by-name/public/view_lineup.sql` |
| M | `supabase/sql/functions/by-name/public/view_refresh_work.sql` |
| M | `supabase/sql/functions/by-name/public/view_roster.sql` |
| M | `supabase/sql/functions/by-name/public/view_trade_details.sql` |
| M | `tests/app/home-slot-capacity.test.ts` |
| M | `tests/app/lineup-empty-slots.test.ts` |
| M | `tests/app/lineup-optimizer-lifetime.test.ts` |
| A | `tests/app/other-matchup-route.test.ts` |
| A | `tests/app/other-matchup-view.test.ts` |
| M | `tests/app/players-empty-state.test.ts` |
| M | `tests/app/propose-trade-ownership.test.ts` |
| M | `tests/boot-shell.test.ts` |
| M | `tests/components/day-selector-clock.test.ts` |
| M | `tests/components/matchup-row-layout.test.ts` |
| A | `tests/components/other-matchups.test.ts` |
| M | `tests/components/player-eligibility-tags.test.ts` |
| M | `tests/components/roster-resolution.test.ts` |
| M | `tests/components/roster-view-polish.test.ts` |
| M | `tests/components/trades/acceptance-summary.test.ts` |
| M | `tests/components/trades/review-details.test.ts` |
| A | `tests/db/home-review-round3.mjs` |
| A | `tests/db/io-write-reductions.sql` |
| A | `tests/db/matchup-forecast-budget.mjs` |
| A | `tests/db/matchup-forecast-cache-parity.sql` |
| M | `tests/db/matchup-forecast-cache.sql` |
| A | `tests/db/matchup-forecast-history.sql` |
| A | `tests/db/player-roster-exact-identity.sql` |
| M | `tests/db/release2-standings-dispatch.sql` |
| M | `tests/db/retention-daily.sql` |
| M | `tests/db/retention-queue.sql` |
| M | `tests/db/trade-estimate-snapshots.sql` |
| A | `tests/db/trade-estimate-work.sql` |
| A | `tests/db/trade-identical-offers.sql` |
| A | `tests/db/trade-legality-drops.sql` |
| A | `tests/db/trade-propose-budget.mjs` |
| A | `tests/db/trade-propose-budget.sql` |
| A | `tests/db/trade-publication.sql` |
| M | `tests/db/trade-roster-plans.sql` |
| A | `tests/db/trade-write-contention.mjs` |
| M | `tests/db/work-queue-lifecycle.sql` |
| M | `tests/db/work-queue-views.sql` |
| M | `tests/draft-live-panel.test.ts` |
| M | `tests/e2e/browser-smoke.mjs` |
| M | `tests/e2e/db-security-catalog-attestations.json` |
| M | `tests/e2e/db-security-catalog.sql` |
| M | `tests/e2e/release-history-attestations.json` |
| M | `tests/e2e/surface-matrix.json` |
| M | `tests/e2e/trade-fixture.mjs` |
| A | `tests/e2e/trade-legality-browser.mjs` |
| M | `tests/e2e/trade-offer-retry-concurrency-db.mjs` |
| M | `tests/e2e/trade-plan-reservation-concurrency-db.mjs` |
| A | `tests/e2e/ui-round4.mjs` |
| A | `tests/e2e/ux-round3.mjs` |
| M | `tests/helpers/home-view-fixture.ts` |
| M | `tests/hooks/home-view-midnight.test.ts` |
| M | `tests/hooks/matchup-data-date-identity.test.ts` |
| A | `tests/hooks/matchup-game-times.test.ts` |
| M | `tests/hooks/matchup-membership-validation.test.ts` |
| A | `tests/hooks/other-matchup-cache.test.ts` |
| A | `tests/hooks/player-age.test.ts` |
| M | `tests/hooks/trade-actions.test.ts` |
| A | `tests/io-write-reductions-negative.mjs` |
| A | `tests/io-write-reductions.test.ts` |
| M | `tests/lib/perf-beacon.test.ts` |
| M | `tests/lib/timezone.test.ts` |
| A | `tests/lib/trade-commit-refresh.test.ts` |
| A | `tests/matchup-forecast-budget.test.ts` |
| M | `tests/screen-request-counts.test.ts` |
| M | `tests/season-sim-cron.test.ts` |
| M | `tests/shell/league-sections.test.ts` |
| M | `tests/shell/mobile-shell.test.ts` |
| M | `tests/shell/modal-layout.test.ts` |
| A | `tests/trade-accept-legality.test.ts` |
| M | `tests/trade-api-routes.test.ts` |
| A | `tests/trade-legality-step.test.ts` |
| A | `tests/trade-propose-budget.test.ts` |
| M | `tests/trade-roster-plan.test.ts` |
| M | `tests/ui/design-system.test.ts` |
| A | `tests/ui/other-matchup-screen.test.ts` |
| M | `types/app.ts` |
| M | `types/database.ts` |
