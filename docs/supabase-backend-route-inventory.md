# Supabase Backend Route Inventory

This inventory maps request ownership and authorization. It does not establish request counts or hosted latency.

## Runtime Boundaries

The client uses several backend boundaries. Only Edge API calls use `https://<project-ref>.supabase.co/functions/v1/api`.

| Boundary | Requests | Source and ownership |
| --- | --- | --- |
| Supabase Auth | Sign-in, sign-up, session refresh, sign-out, password changes | [Auth](../lib/auth.ts), [client](../lib/supabase.ts); session owner |
| PostgREST tables and views | Explicit-column reads, profile updates, notification preferences | [Client libraries](../lib/); database grants and RLS apply |
| PostgREST RPC | Search, read models, lineup changes, roster transactions, league administration | [League](../lib/league.ts), [players](../lib/players.ts), [roster](../lib/roster.ts), [lineup](../lib/lineup/read.ts); function-specific access checks apply |
| Edge API | Trade, waiver, draft, push, and selected league actions | [API caller](../lib/shared/api.ts), [router](../supabase/functions/api/router.ts); route-specific authentication below |
| Storage | Avatar upload and public avatar URL fetch | [Auth/profile library](../lib/auth.ts); upload ownership and public image access differ |
| Realtime | Channel setup, subscription state, changes, and reconnect traffic | [League changes](../lib/league-changes.ts), [drafts](../lib/draft.ts), [rookie drafts](../lib/rookieDraft.ts), [trades](../lib/trades-realtime.ts) |
| Public images | NBA headshot proxy and configured image URLs | [Image URL selection](../lib/format.ts), [Avatar](../components/Avatar.tsx), [headshot handler](../supabase/functions/api/players.ts) |
| App origin and service worker | Documents, scripts, fonts, public assets, worker updates | [Service worker](../public/sw.js); exact public-file allowlist |

Measure HTTP requests and WebSocket frames separately. Record worker traffic even when it starts outside a route action.
The service worker excludes authenticated backend responses and cross-origin headshots from its shared caches.
Public headshots use HTTP caching. Account-scoped application snapshots have separate ownership and freshness rules.

## Current Client Route And Request Inventory

Rows identify request families, not fixed request totals. Shell membership, profile, Auth, image, and Realtime traffic can accompany a route.
Attribute each shared request once. Separate cold document entry, warm SPA return, selected subview, pagination, and submitted mutations.

| Route or subview | Reads and request owner | Writes or additional boundaries |
| --- | --- | --- |
| `/sign-in`, `/sign-up` | Session state in [Auth](../lib/auth.ts) | Auth sign-in/sign-up |
| `/` | Membership, season/week, matchup, lineup, roster, game and live-stat reads in [matchup loader](../hooks/use-matchup-data.ts) | Public avatars; league change stream |
| `/roster` | Current roster, averages, waiver claims, transaction state in [roster](../lib/roster.ts) and [waivers](../lib/waivers.ts) | Direct roster RPCs; Edge IR/taxi and waiver actions |
| `/players?section=players` | `search_players`, ownership and transaction support, averages/projections in [Players](../app/%28tabs%29/players.tsx) | Pickup controls; public avatars |
| `/players?section=rankings` | Bounded `get_dynasty_forecast_inputs` cohort in [dynasty decisions](../lib/dynasty-decisions.ts) | Client scoring and sorting; public avatars |
| `/players?section=news` | Bounded `dynasty_news`; My News first resolves roster IDs in [dynasty](../lib/dynasty.ts) | External article navigation |
| `/dynasty` | Redirects to `/players?section=rankings` | Attribute destination reads to Rankings |
| `/trades` | Bounded trade references/details, pending count, block items in [trades](../lib/trades.ts) | Edge offer, response, roster-plan, and block actions |
| `/league?tab=results` | Season, standings and results through [league resources](../hooks/use-league-tab-resources.ts) | Playoff actions and bracket navigation |
| `/league?tab=history` | `get_league_activity_feed` through [transactions](../lib/transactions.ts) | Offset pagination |
| `/league?tab=settings` | League settings and selected panel support through [league resources](../hooks/use-league-tab-resources.ts) | Commissioner settings navigation |
| `/league?tab=draftBoard` | Scoped draft picks and active draft status through [league resources](../hooks/use-league-tab-resources.ts) | Rookie draft actions |
| `/league?tab=auctions` | Active draft, budgets and room support through [draft controller](../hooks/use-league-draft-controller.ts) | Auction setup and lifecycle actions |
| `/league?tab=mockRooms` | League mock rooms through [mock rooms](../lib/mockDraftRooms.ts) | Create, join, leave, start and delete actions |
| `/draft` | Shared active-draft lookup in [launcher](../hooks/use-draft-room-launcher.ts) | Inline auction room, rookie room navigation, or empty state |
| `/draft-room?draftId=:id` | Draft, nominations, bids, budgets and pool in [auction controller](../hooks/useAuctionDraftRoomController.ts) | Draft Edge actions; room Realtime |
| `/rookie-draft-room?draftId=:id` | Draft, order, picks and prospects in [rookie controller](../hooks/useRookieDraftRoomController.ts) | Pick and timer Edge actions; room Realtime |
| `/profile` | Shared owner profile, preferences and push status in [profile resource](../hooks/use-profile-resource.ts) | Profile/preferences writes, Storage avatar upload, push configuration and subscription, sign-out |
| `/player/:id` | Player, seasons, averages, game log, fantasy points, transactions and projection in [player detail](../hooks/use-player-screen-data.ts) | Pickup controls; paged history and game log |
| `/lineup` | Actor, season/week, schedule, optimizer settings, slots, lineup and roster in [lineup reads](../lib/lineup/read.ts) | Slot RPCs, optimizer settings, Edge rest-of-season optimization |
| `/team-roster?memberId=:id` | Selected roster and averages in [team roster](../app/%28modals%29/team-roster.tsx) | Player navigation |
| `/claim-player?playerId=:id` | Player, roster, priority, transaction limits and waiver clearance in [claim modal](../app/%28modals%29/claim-player.tsx) | Edge waiver claim |
| `/propose-trade` | Members, participant assets and stats in [trade composer](../hooks/use-multi-team-trade-composer.ts) | Edge proposal, counter or edit |
| `/bracket` | Current season and playoff matchups in [bracket](../lib/bracket.ts) | Commissioner playoff actions |
| `/commissioner-settings` | Slots, members and playoff calendar in [settings resource](../hooks/use-commissioner-settings-resource.ts) | League configuration and commissioner RPCs |
| `/create-league`, `/join-league` | Shared session context | `create_league`, `join_league_by_invite_code` in [league](../lib/league.ts) |
| `/change-password` | Shared session context | Auth password change |
| Unknown route | No route-owned server data | Shared shell traffic can still occur |

### Read Bounds And Refresh Rules

| Resource | Current request contract |
| --- | --- |
| Player search | Default 20 rows; subsequent requests advance `p_offset` |
| Player game log | Fetch 16 rows to display 15 and detect another page; advance the range |
| Player transaction history | Default 20 rows with an offset |
| League activity | Default 50 rows with an offset |
| Trade pages | Default 40 entries; request 41 references to detect another page, then fetch selected details |
| Dynasty inputs | Batched ranking and player inputs; limits depend on the requested view |
| Dynasty news | Default 20 rows; My News scopes to the current roster |
| Player projections | Detail requests one player; batch reads scope to requested player IDs |
| Live player stats | Selected date and player IDs; batches contain at most 100 IDs |

Published dynasty tabs preserve source order. League value context does not reorder them.
Record actual limits, offsets, selects, returned row counts, and decoded sizes for each measurement.

Current loaders defer reads while their route is inactive, hidden, or offline. They retain pending work for visible reconnect.
Shared profile and membership resources join concurrent reads. Lineup and player-detail entry coordinate with bounded stream readiness.
Cached membership does not authorize a write. Mutation controls require current ownership and membership validation.

[League changes](../lib/league-changes.ts) consumes `lineup`, `roster`, `score`, `game`, `stat`, `inventory`, and `resources` hints.
Inventory details scope picks, claims, waivers, priority, FAAB, and season changes.
Resource details scope averages, projections, and scoring changes. Daily inputs use trusted source revisions in [daily cache](../lib/league-daily-cache.ts).
Unknown, missing, invalid, or skipped revisions require broader refreshes. Hints do not replace authoritative reads or access checks.
Each league/topic row stores its latest revision; it is not an event log.

## Edge API Routes

Paths below are relative to `/functions/v1/api`. Unmarked paths use `POST`.
JWT routes also apply the actor, league, draft, or trade checks in their handlers and SQL functions.

| Route | Handler | Access and durable operation |
| --- | --- | --- |
| `GET /health` | [router](../supabase/functions/api/router.ts) | Public; release metadata |
| `GET /games/today` | [games](../supabase/functions/api/games.ts) | Public; today's game data |
| `GET /players/headshot/:nbaId` | [players](../supabase/functions/api/players.ts) | Public; numeric NBA ID; cached image proxy |
| `/profile/web-push/config` | [profile](../supabase/functions/api/profile.ts) | Public; VAPID public key or null |
| `/profile/web-push/subscribe`, `/profile/web-push/unsubscribe` | profile | JWT; `register_web_push_atomic`, `clear_web_push_for_user_atomic` |
| `/profile/web-push/test` | profile | JWT; sends to caller's own subscriptions |
| `/profile/push-token` | profile | JWT; `register_push_token_atomic` or `clear_push_token_for_user_atomic` |
| `/profile/push-token/revoke` | profile | Token-specific revocation credential; `revoke_push_token_atomic` |
| `/league/roster/ir`, `/league/roster/taxi` | [league](../supabase/functions/api/league.ts) | JWT and roster ownership; `toggle_ir_atomic`, `toggle_taxi_atomic` |
| `/league/advance-season` | league | Commissioner; `advance_season_atomic` |
| `/league/lineup/auto-set-season` | league | Own member in league; internal `lineup-optimizer` |
| `/waivers/claims` | [waivers](../supabase/functions/api/waivers.ts) | Own member; `create_waiver_claim_atomic` |
| `/waivers/claims/:claimId/cancel`, `/edit`, `/reorder` | waivers | Own member; `cancel_waiver_claim_atomic`, `edit_waiver_claim_atomic`, `reorder_waiver_claim_atomic` |
| `/waivers/process` | waivers | Commissioner; internal `process-waivers` |
| `/trades/propose`, `/trades/propose-multi` | [trades](../supabase/functions/api/trades.ts) | Own proposer; `submit_trade_offer_atomic` |
| `/trades/:tradeId/counter`, `/counter-multi`, `/edit`, `/edit-multi` | trades | Authorized trade actor; `submit_trade_offer_atomic` |
| `/trades/:tradeId/accept` | trades | Trade participant; `accept_trade_atomic` or `accept_trade_with_plan_atomic` |
| `/trades/:tradeId/reject`, `/withdraw`, `/veto` | trades | Action-specific participant/league authority; corresponding `*_trade_atomic` RPC |
| `/trades/:tradeId/roster-plan`, `/taxi-destinations` | trades | Own member; `set_trade_roster_plan_atomic`, `set_trade_taxi_destinations_atomic` |
| `/trades/block`, `/trades/block/:itemId/remove` | trades | Own member; `add_trade_block_item_atomic`, `remove_trade_block_item_atomic` |
| `/draft/start`, `/draft/start-rookie` | [draft](../supabase/functions/api/draft.ts) | Commissioner; `start_auction_draft_atomic`, `start_rookie_draft_atomic` |
| `/draft/mock-room/create` | draft | Own member; `create_mock_draft_room_atomic` |
| `/draft/:draftId/join-mock-room`, `/leave-mock-room`, `/start-mock-room`, `/delete-mock-room` | draft | Own member and room rules; corresponding mock-room atomic RPC |
| `/draft/:draftId/stop`, `/reset`, `/pause`, `/resume` | draft | Commissioner; corresponding draft atomic RPC |
| `/draft/:draftId/nominate`, `/bid`, `/withdraw-nomination` | draft | Own member; auction nomination/bid atomic RPCs |
| `/draft/:draftId/snake-pick`, `/auto-pick`, `/process-expired-pick` | draft | Own member; `make_snake_pick_atomic`, `auto_pick_snake_pick_atomic`, `process_expired_snake_pick_atomic` |
| `/draft/:draftId/commissioner-pick` | draft | Commissioner; `commissioner_snake_pick_atomic` |
| `/draft/:draftId/activate-rookie-league` | draft | JWT and SQL actor checks; `activate_rookie_draft_league_for_user_atomic` |
| `/draft/:draftId/reseed-picks` | draft | Commissioner; `reseed_rookie_draft_picks_atomic` |
| `/draft/:draftId/close-expired` | draft | Draft league member; `close_expired_auction_nominations_atomic` |
| `/draft/:draftId/pause-for-absence`, `/resume-if-absent` | draft | Commissioner; `pause_draft_for_absence_atomic`, `resume_draft_if_absent_atomic` |
| `/playoffs/generate`, `/playoffs/advance` | [playoffs](../supabase/functions/api/playoffs.ts) | Commissioner; `generate_playoff_bracket_atomic`, `advance_playoff_bracket_atomic` |

Abbreviated action paths retain the full prefix from the first path in their row.
Database time and server checks decide auction and rookie deadlines. Browser clocks only display those deadlines.

### Admin And E2E Routes

| Route | Access | Operation |
| --- | --- | --- |
| `POST /sync/matchups` | Admin or league commissioner | Matchup generation through `replace_regular_season_matchups_atomic` |
| `POST /sync/stats` | Admin | `create_or_resume_stats_sync_job_atomic`; queued range processing |
| `POST /sync/scores`, `/schedule`, `/players`, `/rankings`, `/projections`, `/draft-order` | Admin | Corresponding internal `sync-*` function |
| `POST /sync/backfill`, `GET /sync/backfill/:jobId` | Admin | Start backfill or read progress |
| `POST /sync/test-endpoints`, `/verify-stats`, `/validate-db`; `GET /sync/season-totals` | Admin | Internal `verify` actions |
| `/e2e/*` | `x-e2e-secret` | Explicit test hooks; [E2E handler](../supabase/functions/api/e2e.ts) defines methods and actions |

[Sync routing](../supabase/functions/api/sync.ts) uses `ADMIN_USER_IDS` for admin authorization.
Internal Edge functions have separate dispatch authentication. They are not public client mutation endpoints.
The [Edge inventory check](../scripts/check-edge-functions.mjs) compares configured functions with executable entrypoints.

## Measurement Rules

1. Record the source commit, fixture counts, browser engine, viewport, installed/standalone mode, and worker control state.
2. Separate cold profiles, HTTP-cache returns, application snapshots, and service-worker responses.
3. Reset the segment label immediately after each measured action. Keep setup, navigation, and teardown outside that segment.
4. Record method, endpoint, safe RPC arguments, selects, limits, offsets, status, errors, row counts, and timing.
5. Exclude credentials, Authorization headers, Auth bodies, and response user rows from traces.
6. Separate logical requests, network loads, cache hits, encoded bodies, decoded bodies, and wire bytes including headers.
7. Count WebSocket connections and frames separately from HTTP. Do not infer bytes from request counts.
8. Compare identical route, actor, fixture, cache, browser, and visibility conditions. Attribute shared shell reads only once.
9. Confirm hidden and offline state at request time. Reject traces that do not reach the intended state.
10. Check visible reconnect and changed data after suspension. Fewer requests alone do not prove correct freshness.

In the audited Chromium runtime, `context.setOffline(true)` blocks HTTP but leaves `navigator.onLine` true.
Use actual network blocking plus CDP `Network.overrideNetworkState`; assert `navigator.onLine === false` before the offline action.
For native hidden-tab tests, use a browser target without Playwright's focus override, such as direct launch plus `connectOverCDP` with `noDefaults: true`.
Assert `document.hidden === true` and `visibilityState === 'hidden'` at the fetch boundary. Do not replace visibility getters.

A measurement guard must reject offline traces reporting `online: true` and hidden traces reporting `hidden: false`.
It must also reject successful-image samples containing only errors.
These are harness controls, not application performance results.

WebKit with an iPhone viewport does not prove installed-iPhone suspension behavior.
Record standalone emulation separately; the old baseline and corrected audit use different WebKit modes.
Exclude segments contaminated by the next workflow's setup. Local timing and byte counts do not establish hosted latency or egress cost.

## Images and scheduled work

The web avatar defers offscreen images and falls back to initials after failure.
Measure successful image responses separately from absent or malformed identities.
Logical cache hits do not establish transferred bytes.

[Source monitoring](source-monitoring.md) owns scheduling, invocation reconciliation, retry, and retention rules.
