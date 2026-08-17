# Supabase Backend Route Inventory

Updated: 2026-08-15

All runtime backend traffic targets the single Edge boundary:

`https://<project-ref>.supabase.co/functions/v1/api`

## Public API Routes

| Route | Supabase owner | Auth | Durable write path | Caller |
| --- | --- | --- | --- | --- |
| `GET /health` | `api/index.ts` | none | none | readiness checks |
| `GET /games/today` | `api/games.ts` | none | none | app games/today views |
| `POST /league/roster/ir` | `api/league.ts` | Supabase JWT + member ownership | `toggle_ir_atomic` RPC | roster UI |
| `POST /league/roster/taxi` | `api/league.ts` | Supabase JWT + member ownership | `toggle_taxi_atomic` RPC | roster UI |
| `POST /league/advance-season` | `api/league.ts` | Supabase JWT + commissioner | `advance_season_atomic` RPC | commissioner lifecycle |
| `POST /waivers/claims` | `api/waivers.ts` | Supabase JWT + member ownership | `create_waiver_claim_atomic` RPC | claim-player modal |
| `POST /waivers/claims/:claimId/cancel` | `api/waivers.ts` | Supabase JWT + member ownership | `cancel_waiver_claim_atomic` RPC | waiver claims UI |
| `POST /waivers/claims/:claimId/edit` | `api/waivers.ts` | Supabase JWT + member ownership | `edit_waiver_claim_atomic` RPC | roster waiver claims UI |
| `POST /waivers/claims/:claimId/reorder` | `api/waivers.ts` | Supabase JWT + member ownership | `reorder_waiver_claim_atomic` RPC | roster waiver claims UI |
| `POST /waivers/process` | `api/waivers.ts` | Supabase JWT + commissioner | internal `process-waivers` Edge Function | commissioner/admin tools |
| `POST /trades/propose` | `api/trades.ts` | Supabase JWT + proposer ownership | `propose_trade_atomic` RPC | propose-trade modal |
| `POST /trades/:tradeId/accept` | `api/trades.ts` | Supabase JWT + trade recipient | `accept_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/reject` | `api/trades.ts` | Supabase JWT + trade recipient | `reject_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/withdraw` | `api/trades.ts` | Supabase JWT + trade proposer | `withdraw_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/counter` | `api/trades.ts` | Supabase JWT + trade recipient | `counter_trade_atomic` RPC | propose-trade modal |
| `POST /trades/:tradeId/edit` | `api/trades.ts` | Supabase JWT + trade proposer | `edit_trade_atomic` RPC | propose-trade modal |
| `POST /trades/:tradeId/veto` | `api/trades.ts` | Supabase JWT + league member/commissioner | `veto_trade_atomic` RPC | offers tab |
| `POST /trades/block` | `api/trades.ts` | Supabase JWT + member ownership | `add_trade_block_item_atomic` RPC | trades tab |
| `POST /trades/block/:itemId/remove` | `api/trades.ts` | Supabase JWT + member ownership | `remove_trade_block_item_atomic` RPC | trades tab |
| `POST /draft/start` | `api/draft.ts` | Supabase JWT + commissioner | `start_auction_draft_atomic` RPC | auction draft room |
| `POST /draft/:draftId/stop` | `api/draft.ts` | Supabase JWT + commissioner | `stop_draft_atomic` RPC | auction draft room |
| `POST /draft/:draftId/reset` | `api/draft.ts` | Supabase JWT + commissioner | `reset_draft_atomic` RPC | auction draft room |
| `POST /draft/:draftId/nominate` | `api/draft.ts` | Supabase JWT + member ownership | `create_auction_nomination_atomic` RPC | auction draft room |
| `POST /draft/:draftId/bid` | `api/draft.ts` | Supabase JWT + member ownership | `place_auction_bid_atomic` RPC | auction draft room |
| `POST /draft/:draftId/withdraw-nomination` | `api/draft.ts` | Supabase JWT + member ownership | `withdraw_auction_nomination_atomic` RPC | auction draft room |
| `POST /draft/start-rookie` | `api/draft.ts` | Supabase JWT + commissioner | `start_rookie_draft_atomic` RPC | rookie draft setup |
| `POST /draft/:draftId/snake-pick` | `api/draft.ts` | Supabase JWT + pick owner | `make_snake_pick_atomic` RPC | rookie draft room |
| `POST /draft/:draftId/auto-pick` | `api/draft.ts` | Supabase JWT + commissioner or E2E secret | `make_snake_pick_atomic` RPC | rookie draft room/E2E |
| `POST /draft/:draftId/reseed-picks` | `api/draft.ts` | Supabase JWT + commissioner | `reseed_rookie_draft_picks_atomic` RPC | commissioner tools |
| `POST /playoffs/generate` | `api/playoffs.ts` | Supabase JWT + commissioner | `generate_playoff_bracket_atomic` RPC | league tab |
| `POST /playoffs/advance` | `api/playoffs.ts` | Supabase JWT + commissioner | `advance_playoff_bracket_atomic` RPC | league tab |

## Admin And E2E Routes

| Route | Supabase owner | Auth | Target |
| --- | --- | --- | --- |
| `/sync/stats` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-stats` Edge Function |
| `/sync/scores` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-scores` Edge Function |
| `/sync/schedule` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-schedule` Edge Function |
| `/sync/matchups` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `replace_regular_season_matchups_atomic` RPC |
| `/sync/players` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-players` Edge Function |
| `/sync/rankings` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-rankings` Edge Function |
| `/sync/projections` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-projections` Edge Function |
| `/sync/draft-order` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-draft-order` Edge Function |
| `/sync/backfill` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `backfill` Edge Function |
| `/sync/test-endpoints` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | upstream health probes |
| `/sync/verify-stats` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `verify` Edge Function |
| `/sync/season-totals` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `verify` Edge Function |
| `/sync/validate-db` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `verify` Edge Function |
| `/e2e/*` | `api/e2e.ts` | `x-e2e-secret` | targeted Edge/RPC hooks for local-prod browser validation |
| `/players/headshot/:nbaId` | `api/players.ts` | public GET | cached proxy for NBA CDN player headshots used by Dynasty Hub avatars |

## Client Read Models And RPCs

| Surface | Owner | Auth | Purpose |
| --- | --- | --- | --- |
| `search_players` RPC | Postgres migration `20260629000001_player_search_dynasty_news.sql` | authenticated | Canonical player-pool search with indexed name/stat sorting, availability scopes, health/team/playing-day filters, rookies, and no-stat player inclusion |
| `dynasty_rankings` table | Hashtag Basketball via `sync-rankings` | authenticated read, service-role write | 5-year Points, 3-year Points, and Rookie source rows with rank, optional player match, stats, comments, and sync time |
| `replace_dynasty_rankings` RPC | Postgres migration `20260817000004_dynasty_forecast_views.sql` | service-role only | Atomically replaces one Hashtag view and refreshes `players.dynasty_rank` only from canonical 5-year Points |
| `get_dynasty_forecast_inputs` RPC | Postgres migration `20260817000004_dynasty_forecast_views.sql` | authenticated league member | Loads all three ranks, production, and projections in one bounded batch |
| `players.dynasty_rank` | Hashtag Basketball 5-year Points via `replace_dynasty_rankings` | authenticated read | Denormalized 5-year Points rank for player and draft context |
| `dynasty_news` table | service-role sync/admin paths | authenticated read, service-role write | Curated Dynasty Hub player-movement news |
| `get_member_transaction_state` RPC | Postgres migration `20260701000003_dynasty_transactions_schema.sql` | authenticated league member | Weekly add count, add limit, waiver mode, FAAB balance, and roster-size state for transaction UI |
| `get_league_activity_feed` RPC | Postgres migration `20260701000003_dynasty_transactions_schema.sql` | authenticated league member | Normalized paginated feed combining release transaction and league activity rows |
| `notification_preferences` table | app profile/settings surfaces | authenticated own-row read/write | Per-user notification toggles for trade, waiver, draft, and activity events |

## Scheduled Work

All jobs follow the pg_cron + `invoke_edge_function` pattern with ET wall-clock
guards and idle gating (a gate function skips the Edge invocation when there is
nothing to do). Canonical definitions live in `supabase/migrations/`.

| Job | Invokes | Cadence | Gate |
| --- | --- | --- | --- |
| `nba-sync-schedule` | `sync-schedule` | daily 6:05 ET | offseason-stale payloads skip |
| `nba-sync-players` | `sync-players` | daily 6:00 ET | — |
| `nba-sync-projections` | `sync-projections` | daily 8:00 ET | zero-row parses skip |
| `nba-sync-rankings` | `sync-rankings` | Mondays 7:00 ET | <500 rows refused |
| `nba-sync-draft-order-june` / `-july` | `sync-draft-order` | daily inside Jun 20–Jul 15 | failed days retried by later window days |
| `nba-live-poll` | `sync-scores` | per-minute in the game window | only when a non-Final game exists |
| `nba-lineup-optimizer` | `lineup-optimizer` | every 10 min | only when games exist in the next 7 days |
| `nba-process-waivers` | `process-waivers` | daily 3:00 ET | drains every due claim in one run |
| `nba-process-trades` | `process-trades` | every 5 min | — |
| `nba-close-expired-nominations` | `close-expired-nominations` | every minute | — |
| `season-boundary` | `season-boundary` | daily 9:00 ET | only when a league is active/playoffs/offseason |
| `retention-prune` | `prune_unbounded_history()` (SQL) | Sundays 10:00 UTC | deletes only rows the product never reads (incl. news older than 60 days) |
| `mock-room-expiry` | `expire_mock_draft_rooms()` (SQL) | daily 09:30 UTC | deletes mock rooms 24h after completion, missed schedule, or abandonment |

The `season-boundary` internal function owns the automated season lifecycle:
bracket generation and advancement (48h stat-correction grace), season rollover,
new-season matchup generation, and the week-1 rookie-draft auto-complete
backstop. Commissioner endpoints remain as manual overrides; the automation is a
no-op wherever the commissioner already acted.
