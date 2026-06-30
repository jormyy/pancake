# Supabase Backend Route Inventory

Date: 2026-06-28

Pancake runtime backend traffic now targets:

`https://<project-ref>.supabase.co/functions/v1/api`

The former standalone backend implementation has been removed from the repo.

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
| `POST /waivers/process` | `api/waivers.ts` | Supabase JWT + commissioner | internal `process-waivers` Edge Function | commissioner/admin tools |
| `POST /trades/propose` | `api/trades.ts` | Supabase JWT + proposer ownership | `propose_trade_atomic` RPC | propose-trade modal |
| `POST /trades/:tradeId/accept` | `api/trades.ts` | Supabase JWT + trade recipient | `accept_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/reject` | `api/trades.ts` | Supabase JWT + trade recipient | `reject_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/withdraw` | `api/trades.ts` | Supabase JWT + trade proposer | `withdraw_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/veto` | `api/trades.ts` | Supabase JWT + league member/commissioner | `veto_trade_atomic` RPC | offers tab |
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

## Client Read Models And RPCs

| Surface | Owner | Auth | Purpose |
| --- | --- | --- | --- |
| `search_players` RPC | Postgres migration `20260629000001_player_search_dynasty_news.sql` | authenticated | Canonical player-pool search with indexed name/stat sorting, availability scopes, health/team/playing-day filters, rookies, and no-stat player inclusion |
| `players.dynasty_rank` | synced player data | authenticated read | Dynasty Hub ranking list and player detail context |
| `dynasty_news` table | service-role sync/admin paths | authenticated read, service-role write | Curated Dynasty Hub player-movement news |

## Scheduled Work

| Job | Supabase owner | Schedule | Replacement |
| --- | --- | --- | --- |
| NBA schedule sync | Supabase Cron + `sync-schedule` | existing cron | former standalone cron |
| Player sync | Supabase Cron + `sync-players` | existing cron | former standalone cron |
| Stats/scores/rankings/projections | Supabase Cron + Edge Functions | existing cron | former standalone cron/admin routes |
| Live poll | Supabase Cron + `live-poll` | game-window cron | former always-on poller |
| Waiver processing | Supabase Cron/admin + `process-waivers` calling `process_due_waiver_claims_atomic` | existing cron/manual API | former backend processor |
| Accepted trade completion | Supabase Cron + `process-trades` calling `process_due_accepted_trades_atomic` | every 5 minutes | former interval loop |
| Auction nomination expiry | Supabase Cron + `close-expired-nominations` calling `close_expired_auction_nominations_atomic` | every minute | former interval loop |

## Deleted Surfaces

| Surface | Status |
| --- | --- |
| Former deploy config | removed with the retired backend directory |
| Former standalone startup | removed with the retired backend directory |
| Legacy Supabase JWT keys | disabled in hosted Supabase project; app and E2E use `sb_publishable_`/`sb_secret_` keys |
| Direct frontend legacy API URL | removed; `lib/shared/api.ts` falls back to `/functions/v1/api` |
