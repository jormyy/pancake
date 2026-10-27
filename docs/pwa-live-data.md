# PWA behavior

The PWA uses a public cached shell and private screen snapshots. This document defines player detail, offline actions, reconnects, updates, and push.

## Public shell

`app/+html.tsx` and `constants/boot-shell.ts` paint the public frame before app startup.
Signed-out routes use static forms until their live routes become ready.
Saved league identity belongs to the configured project and user.
It does not authorize reads or actions.

`public/sw.js` caches approved same-origin public files.
It excludes API, Auth, Realtime, private responses, and cross-origin images.
The release stamper supplies the public file manifest and content digests.
Installation verifies the complete boot set before activation.
Activation removes older Pancake caches.
Network fallback handles missing or corrupt cache entries.

A first install needs a network connection.
An installed shell can reopen offline, but an unvisited route can lack required assets.
See [release provenance](release-build-provenance.md) for stamped builds and update checks.

## Player detail

`app/player/[id].tsx` presents identity, roster status, season averages, the next-game projection, recent games, and league history.
Identity includes team, eligible positions, dynasty rank, and injury status when available.
The compact header shows experience only when space permits.
Player rows and detail show Rookie and Taxi tags from stored server values.
Taxi appears only when the league has taxi slots; an unknown non-rookie career count shows no Taxi tag.
The existing injury badge carries injury status.
[Roster lifecycle](roster-lifecycle.md#taxi-eligibility-and-trade-plans) defines eligibility and acquisition rules.
Roster status shows Add for free agents or Claim for players on waivers.
Owned players have Lineup and Drop controls. Players on another roster have no pickup control.
Eligible free agents can enter IR or taxi directly through the existing add controls.
Eligible waiver claims expose destination switches in the existing claim form.
Actions require an online connection and current membership and roster reads.

Season averages share one compact stat grid.
A season dropdown appears when multiple seasons are available.
It changes averages and recent games; the next-game projection uses the current season.
The projection shows its source, matchup, fantasy points, and available tipoff time.
Stale projections show an Outdated label.
[Source monitoring](source-monitoring.md#projection-readers) defines provider selection and freshness.

Recent games support pagination and show shooting totals and league fantasy points when available.
League history starts collapsed and appears only when transactions exist.
Wide screens place profile statistics beside recent games.
The page waits for its initial section reads to settle before showing the body.
Read failures show a warning and preserve available content.

## Cache and offline

Each screen reads its server view through the versioned screen cache.
Keys include account, league, member, season, screen, and normalized parameters.
The cache keeps at most 48 entries and 4 MiB of JSON.
Saved content renders before the version check finishes.
Unchanged versions reuse saved content.
Changed topics invalidate affected views.
Background standings, matchup totals, averages, and trade values publish their own version changes.
Refresh metadata causes no version bump.
Publication hints do not restart the background refresh.
Missing change ranges require a fresh view.
Foreground and reconnect checks use the version endpoint.
The screen loaders add no unchanged-data polling timer.
Draft countdowns continue to update local display time.

Account changes clear private views and reject late responses.
League selection clears screen results before changing the selected member.
The service worker continues to cache public assets separately.
Storage denial leaves readable in-memory results.
A cold offline screen cannot invent missing data.
The app shows its offline notice while saved screens remain readable.

Offline API and guarded RPC actions keep their original request IDs.
The queue stores account, league, affected row IDs, and original input.
It stores no bearer token.
Reconnect uses the current matching account and sends actions in order.
A failed replay stays saved and blocks later actions.
The affected row shows Pending.
The shared notice offers Retry.
Immutable queue snapshots keep pending notices current in compiled releases.
Private WebKit checks prove failed replay retains input and retries with the same ID.
Repeated delivery creates one claim.
Accepted trades and awarded waivers appear after one version bump each.
Browser checks also cover league switching, sign-out, and the next account.
Retry preserves the request ID and input.
The database request guard prevents repeated effects.

See [loading checks](instant-loading.md#cache-and-offline) for the focused unit and WebKit recipes.
Browser parity and replay receipts must pass before accepting the client migration.

## Updates and push

The document and worker share one release identity.
Worker checks run on foreground return, reconnect, and periodically while visible.
An update waits for a visible online page and for active mutation holds to release.
The live auction and open claim, trade, and lineup editors hold updates while active.
Backgrounding an editor keeps its hold. Closing the editor permits a pending update.
Updates never reload a hidden page. Reconnecting retries a failed update check immediately.
A long wait shows a notice; it never forces a held reload.
A session marker limits repeated automatic reloads for the same release.
Missing old route files use the same guarded recovery path.
Reload requests worker activation and waits for the replacement worker to control the page.
A registration without a waiting worker permits a direct reload after its update check.
An explicit idle reply from any shell permits activation. A held reply or timeout blocks activation.
Returning from player details restores the Matchup, Players, and Roster scroll positions.
Positions stay separate for each account, team, matchup date, and player search.

Web Push needs all three VAPID variables in `.env.example`.
Subscription notices, reconnect, controller changes, and foreground return reconcile existing subscriptions.
Missing subscriptions or changed VAPID keys require an explicit Enable action.
Disabled or signed-out intent stays closed.

## Sign-out

Sign-out requests server revocation and then clears local identity under the Auth lock.
If the server request fails, the app reports that only this device's sign-out is confirmed.
Project-scoped logout markers fence saved sessions and late Auth responses across tabs.
If storage rejects every persistent change, durable erasure cannot be guaranteed after process restoration.

## Verification

Use the [browser setup](../tests/e2e/README.md#supported-web-clients) before these checks:

```sh
npm run e2e:browser-pwa-launch
npm run e2e:pwa-update -- --previous=<previous-build> --next=dist
npm run e2e:web-targets
```

The update check requires two complete stamped builds.
Headless WebKit simulates phone sizes, standalone mode, and safe areas.
Physical installation, keyboard placement, status bars, and background suspension need a real iPhone.

## Versions

Each league has one counter in `league_versions`.
One transaction produces one bump per changed league.
Nested calls and writes to several tables share that bump.
Rollback removes all pending work.
An unchanged row produces no bump.
Internal leases, notification delivery, push tokens, and retry timestamps produce no bump.

`league_changes` keeps the last 128 changes per league.
Each entry has a version, topic, scope, and creation time.
Scope lists affected topics and source tables.
It contains no player, bid, or member details.
A transaction with several topics uses `batch`.
Older cursors receive one `catchup` entry.

`GET /version?league=<uuid>&since=<decimal>` returns `{version, changes}`.
Counters use decimal strings to preserve bigint precision.
The route requires a signed-in user and current league membership.
It sends `Cache-Control: private, no-store`.
An unchanged request reads one primary-key row from `league_versions`.
It reads no membership, screen, or change-log table.
That row holds the current allowed user IDs.
Member changes refresh those IDs under the version row lock.
The changed path reads the `(league_id, version)` index in `league_changes`.

Each bump publishes one `version` row on the existing `league_change_hints` stream.
Its `details` array contains the change and its exact version string.
Existing topic hints remain available to consumers that have not moved to screen views.
No second channel is added.

`readLeagueVersion` reads the endpoint and keeps the greatest applied counter.
`compareLeagueVersions` compares exact decimal counters.
`subscribeLeagueVersion` consumes the existing shared stream.
Mount `useLeagueChangeStream` before using that subscription.
`useLeagueVersion` adds initial, foreground, and reconnect reads.
It adds no polling timer.
Repeated or reversed versions produce no notification.
A missed range produces `catchup`.
Cache clearing preserves the counter and sends `catchup`.
Account changes clear counters and reject late replies.
A saved `since` value also prevents a lower reply from replacing applied state.

Run these recipes against a private stack:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-writes.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-coverage.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-reads.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-concurrency.sql
npx vitest run tests/lib/league-version.test.ts tests/hooks/use-league-version.test.ts tests/lib/league-changes.test.ts tests/hooks/league-change-stream.test.ts
```

Set `PANCAKE_TEST_DB_PORT` when the private database does not use port 59122.
The write recipe includes the draft, transaction, score, roster, and player recipes.
It checks 126 committed operations against the counter, log, and realtime row.
The coverage recipe follows SQL calls from every atomic RPC and each listed worker RPC.
It checks all reachable screen mutations for insert, update, and delete triggers.
It also calls every entry with invalid inputs and proves rollback leaves no pending version.
The read recipe hides the other tables during the unchanged read.
It also checks retention and old cursors.
The concurrency recipe checks two commits and removed-member access.
Negative controls disable a trigger, retain stale access, and accept a reversed client version.
Each control must fail its check.

This inventory records the current proof for each SQL entry.
`T` means every reachable screen table has all three capture triggers.
`R` means an invoked rejected call or forced rollback leaves no pending work.
`C` means the write recipe also runs a successful committed change through that entry.
That includes nested `save_game_stats_atomic` calls from the live and final snapshot cases.
`Z` means the write recipe invokes that entry and checks zero bumps.
Entries without `C` still need a successful commit case for the full per-RPC acceptance requirement.
The three `drop_player_atomic` overloads share one inventory row.

| SQL entry | Screen tables | Proof |
| --- | --- | --- |
| `accept_trade_atomic` | `draft_picks`, `faab_balances`, `league_activity`, `roster_players`, `roster_transactions`, `trade_participants`, `trades`, `waiver_claims`, `waiver_wire_log` | T, R, C |
| `accept_trade_with_plan_atomic` | `draft_picks`, `faab_balances`, `league_activity`, `roster_players`, `roster_transactions`, `trade_items`, `trade_participants`, `trades`, `waiver_claims`, `waiver_wire_log` | T, R, C |
| `activate_rookie_draft_league_atomic` | `leagues`, `roster_players`, `roster_transactions` | T, R |
| `activate_rookie_draft_league_for_user_atomic` | `leagues`, `roster_players`, `roster_transactions` | T, R |
| `activate_roster_player_with_lineup_atomic` | `leagues`, `roster_players`, `roster_transactions`, `waiver_wire_log`, `weekly_lineups` | T, R, C |
| `activate_roster_player_with_overflow_atomic` | `leagues`, `roster_players`, `roster_transactions`, `waiver_wire_log` | T, R, C |
| `add_free_agent_atomic` | `league_activity`, `roster_players`, `roster_transactions`, `weekly_add_counts` | T, R, Z |
| `add_trade_block_item_atomic` | `league_activity`, `trade_block_items` | T, R, C |
| `advance_playoff_bracket_atomic` | `matchups` | T, R |
| `advance_season_atomic` | `draft_picks`, `league_seasons`, `leagues`, `roster_players`, `roster_transactions`, `trades`, `waiver_priorities` | T, R |
| `apply_pre_tipoff_lineup` | `lineup_optimizer_settings`, `weekly_lineups` | T, R |
| `apply_season_boundary_after_grace` | `draft_picks`, `league_seasons`, `leagues`, `matchups`, `roster_players`, `roster_transactions`, `trades`, `waiver_priorities` | T, R |
| `assert_nba_game_imports` | None | R; internal or read only |
| `assert_nba_game_unambiguous` | None | R; internal or read only |
| `assign_player_nba_id_atomic` | `dynasty_news`, `dynasty_rankings`, `fantasypros_projection_rows`, `league_activity`, `league_member_taxi_exits`, `league_player_taxi_exits`, `nominations`, `player_game_stats`, `player_projections`, `player_watches`, `players`, `roster_players`, `roster_transactions`, `snake_draft_picks`, `trade_block_items`, `trade_items`, `waiver_claims`, `waiver_wire_log`, `weekly_lineups` | T, R, C |
| `auto_pick_snake_pick_atomic` | `draft_audit_logs`, `draft_picks`, `drafts`, `leagues`, `roster_players`, `roster_transactions`, `snake_draft_picks` | T, R, C |
| `auto_set_lineup_atomic` | `weekly_lineups` | T, R, C |
| `auto_set_lineup_service_atomic` | `weekly_lineups` | T, R, C |
| `cancel_waiver_claim_atomic` | `waiver_claims` | T, R, C |
| `capture_score_inputs` | None | R; internal or read only, C |
| `checkpoint_stats_sync_job_atomic` | None | R; internal or read only |
| `claim_lineup_tipoff_dispatch` | None | R; internal or read only |
| `claim_matchup_forecasts` | None | R; internal or read only |
| `claim_notification_outbox_atomic` | None | R; internal or read only |
| `claim_notification_receipts_atomic` | None | R; internal or read only |
| `claim_player_career_base_atomic` | `players` | T, R, C |
| `claim_stats_sync_job_atomic` | None | R; internal or read only |
| `clear_push_token_for_user_atomic` | `profiles` | T, R, Z |
| `clear_web_push_for_user_atomic` | None | R; internal or read only |
| `close_auction_nomination_atomic` | `draft_budgets`, `drafts`, `leagues`, `nominations`, `roster_players`, `roster_transactions` | T, R, C |
| `close_expired_auction_nominations_atomic` | `draft_budgets`, `drafts`, `leagues`, `nominations`, `roster_players`, `roster_transactions` | T, R |
| `commissioner_adjust_faab_balance_atomic` | `faab_balances`, `league_activity` | T, R, C |
| `commissioner_override_weekly_add_count_atomic` | `league_activity`, `weekly_add_counts` | T, R, C |
| `commissioner_snake_pick_atomic` | `draft_audit_logs`, `draft_picks`, `drafts`, `leagues`, `roster_players`, `roster_transactions`, `snake_draft_picks` | T, R, C |
| `complete_accepted_trade_atomic` | `draft_picks`, `faab_balances`, `league_activity`, `roster_players`, `roster_transactions`, `trades`, `waiver_claims`, `waiver_wire_log` | T, R, C |
| `complete_matchup_forecast` | `matchup_forecasts` | T, R |
| `complete_notification_outbox_atomic` | None | R; internal or read only |
| `complete_player_career_base_atomic` | `players` | T, R, C |
| `complete_player_roster_cycle_atomic` | `players` | T, R |
| `complete_sleeper_projection_sync` | `projection_sync_runs`, `sleeper_projection_rows` | T, R |
| `complete_stats_sync_job_atomic` | None | R; internal or read only |
| `count_due_waiver_claims` | None | R; internal or read only |
| `count_final_games_missing_stats` | None | R; internal or read only |
| `create_auction_nomination_atomic` | `nominations` | T, R, C |
| `create_mock_draft_room_atomic` | `draft_room_members`, `drafts` | T, R, C |
| `create_or_resume_stats_sync_job_atomic` | None | R; internal or read only |
| `create_waiver_claim_atomic` | `faab_balances`, `waiver_claims`, `weekly_add_counts` | T, R, C |
| `dead_letter_notification_outbox_atomic` | None | R; internal or read only |
| `defer_notification_receipt_state_atomic` | None | R; internal or read only |
| `delete_league_atomic` | `drafts`, `league_audit_logs`, `leagues`, `nominations`, `snake_draft_picks` | T, R |
| `delete_mock_draft_room_atomic` | `drafts` | T, R, C |
| `draft_timer_start_warning` | None | R; internal or read only |
| `drop_and_add_free_agent_atomic` | `league_activity`, `leagues`, `roster_players`, `roster_transactions`, `waiver_wire_log`, `weekly_add_counts` | T, R, Z |
| `drop_player_atomic` | `leagues`, `roster_players`, `roster_transactions`, `waiver_wire_log` | T, R, C |
| `edit_waiver_claim_atomic` | `faab_balances`, `waiver_claims`, `weekly_add_counts` | T, R, C |
| `expire_pending_trades_atomic` | `league_activity`, `trades` | T, R, C |
| `expire_trade_completion_failure_atomic` | `league_activity`, `trades` | T, R, C |
| `expire_waiver_wire_logs` | `waiver_wire_log` | T, R, C |
| `fail_matchup_forecast` | None | R; internal or read only |
| `fail_notification_outbox_atomic` | None | R; internal or read only |
| `fail_stats_sync_job_atomic` | None | R; internal or read only |
| `finalize_score_week_atomic` | `matchups`, `standings` | T, R, C |
| `finish_edge_invocation` | None | R; internal or read only |
| `finish_lineup_tipoff_dispatch` | None | R; internal or read only |
| `generate_playoff_bracket_atomic` | `league_seasons`, `matchups` | T, R |
| `get_league_projection_rows` | None | R; internal or read only |
| `get_league_version` | None | R; internal or read only |
| `get_live_poll_work` | None | R; internal or read only |
| `get_matchup_forecast_context` | None | R; internal or read only |
| `get_pending_tipoff_members` | None | R; internal or read only |
| `get_pre_tipoff_lineup_context` | None | R; internal or read only |
| `get_score_sync_games` | None | R; internal or read only |
| `get_stale_score_weeks` | None | R; internal or read only |
| `get_trade_estimate_inputs` | None | R; internal or read only |
| `get_trade_revaluation_inputs` | None | R; internal or read only |
| `get_trade_roster_preview` | None | R; internal or read only |
| `invoke_edge_function` | None | R; internal or read only |
| `join_mock_draft_room_atomic` | `draft_room_members` | T, R, C |
| `leave_mock_draft_room_atomic` | `draft_room_members` | T, R, C |
| `link_player_sources_atomic` | `dynasty_news`, `dynasty_rankings`, `fantasypros_projection_rows`, `league_activity`, `league_member_taxi_exits`, `league_player_taxi_exits`, `nominations`, `player_game_stats`, `player_projections`, `player_watches`, `players`, `roster_players`, `roster_transactions`, `snake_draft_picks`, `trade_block_items`, `trade_items`, `waiver_claims`, `waiver_wire_log`, `weekly_lineups` | T, R, C |
| `make_snake_pick_atomic` | `draft_picks`, `drafts`, `leagues`, `roster_players`, `roster_transactions`, `snake_draft_picks` | T, R, C |
| `merge_duplicate_players` | `dynasty_news`, `dynasty_rankings`, `fantasypros_projection_rows`, `league_activity`, `league_member_taxi_exits`, `league_player_taxi_exits`, `nominations`, `player_game_stats`, `player_projections`, `player_watches`, `players`, `roster_players`, `roster_transactions`, `snake_draft_picks`, `trade_block_items`, `trade_items`, `waiver_claims`, `waiver_wire_log`, `weekly_lineups` | T, R |
| `notif_admit_delivery_atomic` | None | R; internal or read only |
| `notif_begin_web_atomic` | None | R; internal or read only |
| `notif_finish_web_atomic` | None | R; internal or read only |
| `notif_publish_announcement_atomic` | `league_announcements` | T, R, C |
| `notif_scan_due_atomic` | None | R; internal or read only |
| `notif_set_player_watch_atomic` | `player_watches` | T, R, C |
| `notif_suppress_atomic` | None | R; internal or read only |
| `pause_draft_atomic` | `draft_audit_logs`, `drafts`, `nominations`, `snake_draft_picks` | T, R, C |
| `pause_draft_for_absence_atomic` | `draft_audit_logs`, `drafts`, `nominations` | T, R, C |
| `place_auction_bid_atomic` | `bids`, `draft_budgets`, `drafts`, `leagues`, `nominations`, `roster_players`, `roster_transactions` | T, R, C |
| `process_due_accepted_trades_atomic` | `draft_picks`, `faab_balances`, `league_activity`, `roster_players`, `roster_transactions`, `trades`, `waiver_claims`, `waiver_wire_log` | T, R, C |
| `process_due_waiver_claims_atomic` | `faab_balances`, `league_activity`, `roster_players`, `roster_transactions`, `waiver_claims`, `waiver_priorities`, `waiver_wire_log`, `weekly_add_counts` | T, R, C |
| `process_expired_snake_pick_atomic` | `draft_audit_logs`, `draft_picks`, `drafts`, `leagues`, `roster_players`, `roster_transactions`, `snake_draft_picks` | T, R, C |
| `process_expired_snake_picks_atomic` | `draft_audit_logs`, `draft_picks`, `drafts`, `leagues`, `roster_players`, `roster_transactions`, `snake_draft_picks` | T, R, C |
| `process_next_waiver_claim_atomic` | `faab_balances`, `league_activity`, `roster_players`, `roster_transactions`, `waiver_claims`, `waiver_priorities`, `waiver_wire_log`, `weekly_add_counts` | T, R, C |
| `propose_multi_team_trade_atomic` | `faab_balances`, `league_activity`, `trade_items`, `trade_participants`, `trades` | T, R |
| `propose_trade_atomic` | `faab_balances`, `league_activity`, `trade_items`, `trade_participants`, `trades` | T, R, C |
| `publish_nba_schedule_atomic` | `nba_games`, `player_game_stats`, `season_weeks` | T, R |
| `rebuild_nba_calendar_atomic` | `nba_games`, `player_game_stats` | T, R |
| `record_live_poll_attempts` | None | R; internal or read only |
| `record_notification_outbox_ticket_atomic` | None | R; internal or read only |
| `register_push_token_atomic` | `profiles` | T, R, Z |
| `register_web_push_atomic` | None | R; internal or read only |
| `reject_trade_atomic` | `trades` | T, R, C |
| `release_live_poll_lease` | None | R; internal or read only |
| `release_stats_sync_job_atomic` | None | R; internal or read only |
| `remove_trade_block_item_atomic` | `league_activity`, `trade_block_items` | T, R, C |
| `renew_lineup_tipoff_dispatch` | None | R; internal or read only |
| `renew_live_poll_lease` | None | R; internal or read only |
| `reorder_waiver_claim_atomic` | `waiver_claims` | T, R, C |
| `replace_dynasty_rankings` | `dynasty_rankings`, `players` | T, R, C |
| `replace_regular_season_matchups_atomic` | `matchups` | T, R |
| `reseed_rookie_draft_picks_atomic` | `snake_draft_picks` | T, R, C |
| `reset_draft_atomic` | `bids`, `draft_audit_logs`, `draft_budgets`, `draft_picks`, `drafts`, `leagues`, `nominations`, `roster_players`, `roster_transactions`, `snake_draft_picks` | T, R, C |
| `resolve_player_imports_atomic` | `dynasty_news`, `dynasty_rankings`, `fantasypros_projection_rows`, `league_activity`, `league_member_taxi_exits`, `league_player_taxi_exits`, `nominations`, `player_game_stats`, `player_projections`, `player_watches`, `players`, `roster_players`, `roster_transactions`, `snake_draft_picks`, `trade_block_items`, `trade_items`, `waiver_claims`, `waiver_wire_log`, `weekly_lineups` | T, R, C |
| `resume_draft_atomic` | `draft_audit_logs`, `drafts`, `nominations`, `snake_draft_picks` | T, R, C |
| `resume_draft_if_absent_atomic` | `draft_audit_logs`, `drafts`, `nominations` | T, R, C |
| `revoke_push_token_atomic` | `profiles` | T, R, Z |
| `save_final_game_snapshot_atomic` | `nba_games`, `player_game_stats` | T, R, C, Z |
| `save_game_stats_atomic` | `nba_games`, `player_game_stats` | T, R, C |
| `save_live_game_stats_atomic` | `nba_games`, `player_game_stats` | T, R, C |
| `save_live_scoreboard_atomic` | `nba_games` | T, R, C, Z |
| `save_trade_estimate_quote` | `trade_estimate_quotes` | T, R, C |
| `set_player_slot_atomic` | `weekly_lineups` | T, R, C |
| `set_player_slot_moves_atomic` | `weekly_lineups` | T, R, C |
| `set_trade_roster_plan_atomic` | `trade_items`, `trade_participants` | T, R, C |
| `set_trade_taxi_destinations_atomic` | `trade_items` | T, R, Z |
| `start_auction_draft_atomic` | `draft_budgets`, `draft_orders`, `drafts`, `leagues` | T, R, C |
| `start_edge_invocation` | None | R; internal or read only |
| `start_mock_draft_room_atomic` | `draft_budgets`, `draft_orders`, `drafts`, `snake_draft_picks` | T, R, C |
| `start_rookie_draft_atomic` | `draft_orders`, `draft_picks`, `drafts`, `leagues`, `snake_draft_picks` | T, R, C |
| `stop_draft_atomic` | `draft_audit_logs`, `draft_picks`, `drafts`, `leagues`, `nominations`, `roster_players`, `roster_transactions`, `snake_draft_picks` | T, R, C |
| `submit_trade_offer_atomic` | `faab_balances`, `league_activity`, `trade_estimates`, `trade_items`, `trade_participants`, `trades` | T, R |
| `toggle_ir_atomic` | `leagues`, `roster_players`, `roster_transactions` | T, R, C |
| `toggle_taxi_atomic` | `leagues`, `roster_players`, `roster_transactions` | T, R |
| `try_live_poll_lease` | None | R; internal or read only |
| `update_league_configuration_atomic` | `faab_balances`, `league_seasons`, `leagues`, `lineup_slot_templates`, `matchups`, `standings` | T, R, C, Z |
| `update_league_settings_atomic` | `faab_balances`, `league_seasons`, `leagues`, `matchups`, `standings` | T, R, C |
| `update_lineup_slots_atomic` | `lineup_slot_templates` | T, R, C |
| `update_score_points_atomic` | `matchups` | T, R, C |
| `veto_trade_atomic` | `trade_vetos`, `trades` | T, R, C |
| `withdraw_auction_nomination_atomic` | `nominations` | T, R |
| `withdraw_trade_atomic` | `trades` | T, R, C |

Workers also write these tables without an RPC.
Their screen tables use the same capture triggers.

| Worker source | Table | Proof |
| --- | --- | --- |
| `supabase/functions/_shared/backfillJobs.ts` | `sync_jobs` | Internal; no bump |
| `supabase/functions/_shared/backfillJobs.ts` | `backfill_game_attempts` | Internal; no bump |
| `supabase/functions/_shared/cdnBackfill.ts` | `nba_games` | T, C |
| `supabase/functions/_shared/notificationDraft.ts` | `notification_outbox` | Internal; no bump |
| `supabase/functions/_shared/notifications.ts` | `web_push_subscriptions` | Internal; no bump |
| `supabase/functions/_shared/seasonBoundary.ts` | `leagues` | T, C |
| `supabase/functions/_shared/syncRuns.ts` | `sync_runs` | Internal; no bump |
| `supabase/functions/lineup-optimizer/index.ts` | `lineup_optimizer_settings` | T, C |
| `supabase/functions/sync-players/career.ts` | `players` | T, C |
| `supabase/functions/sync-players/index.ts` | `dynasty_news` | T |
| `supabase/functions/sync-players/injuries.ts` | `players` | T, C |
| `supabase/functions/sync-players/nbaIds.ts` | `players` | T, C |
| `supabase/functions/sync-projections/index.ts` | `projection_sync_runs` | T |
| `supabase/functions/sync-projections/index.ts` | `fantasypros_projection_rows` | T |
| `supabase/functions/sync-projections/index.ts` | `player_projections` | T, C |
| `supabase/functions/sync-sleeper-projections/sync.ts` | `projection_sync_runs` | T |

The inventory proves trigger coverage for every discovered path.
The live test uses the same private channel setting as the app.
It does not replace successful commit fixtures for entries marked only `T, R`.
