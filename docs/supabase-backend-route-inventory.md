# Supabase Backend Route Inventory

Date: 2026-06-28

Pancake runtime backend traffic now targets:

`https://<project-ref>.supabase.co/functions/v1/api`

The former Railway/Fastify implementation is isolated in
`backend-legacy-railway/` as non-runtime rollback reference only.

## Public API Routes

| Route | Supabase owner | Auth | Durable write path | Caller |
| --- | --- | --- | --- | --- |
| `GET /health` | `api/index.ts` | none | none | readiness checks |
| `GET /games/today` | `api/games.ts` | none | none | app games/today views |
| `POST /league/roster/ir` | `api/league.ts` | Supabase JWT + member ownership | `toggle_ir_atomic` RPC | roster UI |
| `POST /league/roster/taxi` | `api/league.ts` | Supabase JWT + member ownership | `toggle_taxi_atomic` RPC | roster UI |
| `POST /league/advance-season` | `api/league.ts` | Supabase JWT + commissioner | `advance_season_atomic` RPC | commissioner lifecycle |
| `POST /waivers/claims` | `api/waivers.ts` | Supabase JWT + member ownership | `submit_waiver_claim_atomic` RPC | claim-player modal |
| `POST /waivers/claims/:claimId/cancel` | `api/waivers.ts` | Supabase JWT + member ownership | `cancel_waiver_claim_atomic` RPC | waiver claims UI |
| `POST /waivers/process` | `api/waivers.ts` | Supabase JWT + commissioner | internal `process-waivers` Edge Function | commissioner/admin tools |
| `POST /trades/propose` | `api/trades.ts` | Supabase JWT + proposer ownership | `propose_trade_atomic` RPC | propose-trade modal |
| `POST /trades/:tradeId/accept` | `api/trades.ts` | Supabase JWT + trade recipient | `accept_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/reject` | `api/trades.ts` | Supabase JWT + trade recipient | `reject_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/withdraw` | `api/trades.ts` | Supabase JWT + trade proposer | `withdraw_trade_atomic` RPC | offers tab |
| `POST /trades/:tradeId/veto` | `api/trades.ts` | Supabase JWT + league member/commissioner | `veto_trade_atomic` RPC | offers tab |
| `POST /draft/start` | `api/draft.ts` | Supabase JWT + commissioner | `start_auction_draft_atomic` RPC | auction draft room |
| `POST /draft/:draftId/stop` | `api/draft.ts` | Supabase JWT + commissioner | draft status update | auction draft room |
| `POST /draft/:draftId/reset` | `api/draft.ts` | Supabase JWT + commissioner | draft/nomination/bid reset | auction draft room |
| `POST /draft/:draftId/nominate` | `api/draft.ts` | Supabase JWT + member ownership | `nominate_player_atomic` RPC | auction draft room |
| `POST /draft/:draftId/bid` | `api/draft.ts` | Supabase JWT + member ownership | `place_auction_bid_atomic` RPC | auction draft room |
| `POST /draft/:draftId/withdraw-nomination` | `api/draft.ts` | Supabase JWT + member ownership | `withdraw_auction_nomination_atomic` RPC | auction draft room |
| `POST /draft/start-rookie` | `api/draft.ts` | Supabase JWT + commissioner | `start_rookie_draft_atomic` RPC | rookie draft setup |
| `POST /draft/:draftId/snake-pick` | `api/draft.ts` | Supabase JWT + pick owner | `make_snake_pick_atomic` RPC | rookie draft room |
| `POST /draft/:draftId/auto-pick` | `api/draft.ts` | Supabase JWT + commissioner or E2E secret | `make_snake_pick_atomic` RPC | rookie draft room/E2E |
| `POST /draft/:draftId/reseed-picks` | `api/draft.ts` | Supabase JWT + commissioner | rookie pick reseed writes | commissioner tools |
| `POST /playoffs/generate` | `api/playoffs.ts` | Supabase JWT + commissioner | playoff matchup/standings writes | league tab |
| `POST /playoffs/advance` | `api/playoffs.ts` | Supabase JWT + commissioner | playoff round/status writes | league tab |

## Admin And E2E Routes

| Route | Supabase owner | Auth | Target |
| --- | --- | --- | --- |
| `/sync/stats` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-stats` Edge Function |
| `/sync/scores` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-scores` Edge Function |
| `/sync/schedule` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `sync-schedule` Edge Function |
| `/sync/matchups` | `api/sync.ts` | Supabase JWT + `ADMIN_USER_IDS` | `api/matchups.ts` service routine |
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

## Scheduled Work

| Job | Supabase owner | Schedule | Replacement |
| --- | --- | --- | --- |
| NBA schedule sync | Supabase Cron + `sync-schedule` | existing cron | former Railway cron |
| Player sync | Supabase Cron + `sync-players` | existing cron | former Railway cron |
| Stats/scores/rankings/projections | Supabase Cron + Edge Functions | existing cron | former Railway cron/admin routes |
| Live poll | Supabase Cron + `live-poll` | game-window cron | former always-on poller |
| Waiver processing | Supabase Cron/admin + `process-waivers` | existing cron/manual API | former backend processor |
| Accepted trade completion | Supabase Cron + `process-trades` | every 5 minutes | former interval loop |
| Auction nomination expiry | Supabase Cron + `close-expired-nominations` | every minute | former interval loop |

## Deleted Or Isolated Surfaces

| Surface | Status |
| --- | --- |
| Railway deploy config | isolated under `backend-legacy-railway/railway.json`; no active workspace path |
| Fastify startup | isolated under `backend-legacy-railway/src/index.ts`; no root script or workspace |
| Legacy Supabase JWT keys | disabled in hosted Supabase project; app and E2E use `sb_publishable_`/`sb_secret_` keys |
| Direct frontend Railway URL | removed; `lib/shared/api.ts` falls back to `/functions/v1/api` |
