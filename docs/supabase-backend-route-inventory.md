# Backend route inventory

This inventory maps request ownership and authorization. It does not establish request counts or hosted latency.

## Runtime boundaries

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

## Client route inventory

Rows identify request families, not fixed request totals. Shell membership, profile, Auth, image, and Realtime traffic can accompany a route.
Attribute each shared request once. Separate cold document entry, warm SPA return, selected subview, pagination, and submitted mutations.

| Route or subview | Reads and request owner | Writes or additional boundaries | Entry from Home | Taps | First view |
| --- | --- | --- | --- | --- | --- |
| `/sign-in`, `/sign-up` | Session state in [Auth](../lib/auth.ts) | Auth sign-in/sign-up | Signed-out launch / Create account | 0 / 1 | Authentication form |
| `/` | Membership, season/week, matchup, lineup, roster, game and live-stat reads in [matchup loader](../hooks/use-matchup-data.ts); `notif_list_announcements` through [announcements](../hooks/use-league-announcements.ts) | Public avatars; league change stream; local banner dismissal | Home | 0 | Points, win odds, inline lineup and waiver state |
| `/league` | Shared membership context | Section navigation | League | 1 | League, My team, Draft rooms, Account and commissioner sections |
| `/roster` | Current roster, averages, waiver claims, transaction state in [roster](../lib/roster.ts) and [waivers](../lib/waivers.ts) | Direct roster RPCs; Edge IR/taxi and waiver actions | Roster | 1 | Roster, reserves, picks and claims |
| `/players?section=players` | `search_players`, ownership and transaction support, averages/projections in [Players](../app/%28tabs%29/players.tsx) | Pickup controls; public avatars | Players | 1 | Search and pickup controls |
| `/players?section=rankings` | Bounded `get_dynasty_forecast_inputs` cohort in [dynasty decisions](../lib/dynasty-decisions.ts) | Client scoring and sorting; public avatars | Players > Rankings | 2 | Ranking views and decision tools |
| `/players?section=news` | Bounded `dynasty_news`; My News first resolves roster IDs in [dynasty](../lib/dynasty.ts) | External article navigation | Players > News | 2 | News and roster filters |
| `/dynasty` | Redirects to `/players?section=rankings` | Attribute destination reads to Rankings | Players > Rankings | 2 | Rankings; old route redirects |
| `/trades` | Bounded trade references/details, pending count, block items in [trades](../lib/trades.ts) | Edge offer, response, roster-plan, and block actions | Trades | 1 | Open offers, History and Block |
| `/league?tab=results` | Season, standings and results through [league resources](../hooks/use-league-tab-resources.ts) | Playoff actions and bracket navigation | League > Standings | 2 | Records and results |
| `/league?tab=history` | `get_league_activity_feed` through [transactions](../lib/transactions.ts); `notif_list_announcements` through [league resources](../hooks/use-league-tab-resources.ts) | Offset pagination; announcements follow the loaded time range | League > Activity | 2 | Activity and announcements |
| `/league?tab=settings` | League settings and selected panel support through [league resources](../hooks/use-league-tab-resources.ts) | Commissioner settings navigation | League > League settings | 2 | Rules, invite and priority |
| `/league?tab=draftBoard` | Scoped draft picks and active draft status through [league resources](../hooks/use-league-tab-resources.ts) | Rookie draft actions | League > Picks and draft board | 2 | Pick ownership; draftBoard aliases picks |
| `/league?tab=auctions` | Active draft, budgets and room support through [draft controller](../hooks/use-league-draft-controller.ts) | Auction setup and lifecycle actions | League > Draft setup and mock rooms | 2 | Draft setup; auctions aliases draft |
| `/league?tab=mockRooms` | League mock rooms through [mock rooms](../lib/mockDraftRooms.ts) | Create, join, leave, start and delete actions | League > Draft setup and mock rooms | 2 | Mock rooms; mockRooms aliases draft |
| `/draft` | Shared active-draft lookup in [launcher](../hooks/use-draft-room-launcher.ts) | Inline auction room, rookie room navigation, or empty state | League > Draft Room | 2 | Active room or an explicit empty state |
| `/draft-room?draftId=:id` | Draft, nominations, bids, budgets and pool in [auction controller](../hooks/useAuctionDraftRoomController.ts) | Draft Edge actions; room Realtime | League > Draft setup and mock rooms > Open room | 3 | Clock, bids and budget |
| `/rookie-draft-room?draftId=:id` | Draft, order, picks and prospects in [rookie controller](../hooks/useRookieDraftRoomController.ts) | Pick and timer Edge actions; room Realtime | League > Draft Room | 2 | Pick clock and eligible prospects |
| `/profile` | Shared owner profile in [profile resource](../hooks/use-profile-resource.ts) | Profile and team-name writes, Storage avatar upload, sign-out | League > Profile & settings | 2 | Profile and team settings |
| `/notification-settings` | Shared notification preferences in [profile resource](../hooks/use-profile-resource.ts) | Master, category and event preference writes; web push configuration and subscription | League > Notifications | 2 | Preferences and device push controls |
| `/player/:id` | Player, seasons, averages, game log, fantasy points, transactions and projection in [player detail](../hooks/use-player-screen-data.ts) | Roster and pickup controls; player watch (`notif_set_player_watch_atomic`); paged history and game log; [screen contract](pwa-live-data.md#player-detail) | Players > Player | 2 | Stats, projections and roster actions |
| `/lineup` | Actor, season/week, schedule, optimizer settings, slots, lineup and roster in [lineup reads](../lib/lineup/read.ts) | Slot RPCs, optimizer settings, Edge rest-of-season optimization | League > Lineup; shared editor also appears on Home | 2 / 0 | Direct actions, automatic switch and locked slots |
| `/team-roster?memberId=:id` | Selected roster and averages in [team roster](../app/%28modals%29/team-roster.tsx) | Player navigation | League > Standings > Team | 3 | Selected roster |
| `/claim-player?playerId=:id` | Player, roster, priority, transaction limits and waiver clearance in [claim modal](../app/%28modals%29/claim-player.tsx) | Edge waiver claim | Home > Find a player to claim > Claim | 2 | Bid, drop and destination form |
| `/propose-trade` | Members, participant assets and stats in [trade composer](../hooks/use-multi-team-trade-composer.ts) | Edge proposal, counter or edit | Trades > Propose | 2 | Multi-team composer |
| `/bracket` | Current season and playoff matchups in [bracket](../lib/bracket.ts) | Commissioner playoff actions | League > Playoffs | 2 | Bracket and eligible actions |
| `/commissioner-settings` | Slots, members and playoff calendar in [settings resource](../hooks/use-commissioner-settings-resource.ts) | League configuration and commissioner RPCs; league announcement (`notif_publish_announcement_atomic`); playoff fit check | League > Commissioner | 2 | Scoring, rules, lifecycle and member controls |
| `/create-league`, `/join-league` | Shared session context | `create_league`, `join_league_by_invite_code` in [league](../lib/league.ts) | League > Create a League / Join with Invite Code | 2 | Selected league form |
| `/change-password` | Shared session context | Auth password change | League > Change password | 2 | Password form |
| Unknown route | No route-owned server data | Shared shell traffic can still occur | Unknown address | 0 | Missing page with Home action |
| `/timeline` | Team timeline screen | Filter team events and inspect decisions | Home > Timeline or League > Season timeline | 1–2 | Team events or a load error with retry |

### Read bounds and refresh rules

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

`get_league_projection_rows` owns projection selection for player views and lineup optimization.
[Source monitoring](source-monitoring.md#projection-readers) defines Sleeper-first selection and per-game fallback.
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

## Edge API routes

Paths below are relative to `/functions/v1/api`. Unmarked paths use `POST`.
JWT routes also apply the actor, league, draft, or trade checks in their handlers and SQL functions.

| Route | Handler | Access and durable operation | Entry from Home / taps |
| --- | --- | --- | --- |
| `GET /health` | [router](../supabase/functions/api/router.ts) | Public; release metadata | Automatic release health check / 0 |
| `GET /games/today` | [games](../supabase/functions/api/games.ts) | Public; today's game data | Home game display / 0 |
| `GET /players/headshot/:nbaId` | [players](../supabase/functions/api/players.ts) | Public; numeric NBA ID; cached image proxy | Players > Player / 2; images also appear in lineups |
| `/profile/web-push/config` | [profile](../supabase/functions/api/profile.ts) | Public; VAPID public key or null | League > Notifications / 2 |
| `/profile/web-push/subscribe`, `/profile/web-push/unsubscribe` | profile | JWT; `register_web_push_atomic`, `clear_web_push_for_user_atomic` | League > Notifications / 2 |
| `/profile/web-push/test` | profile | JWT; sends to caller's own subscriptions | League > Notifications / 2 |
| `/league/roster/ir`, `/league/roster/taxi` | [league](../supabase/functions/api/league.ts) | JWT and roster ownership; `toggle_ir_atomic`, `toggle_taxi_atomic` | Roster > Player > IR or Taxi / 3 |
| `/league/advance-season` | league | Commissioner; `advance_season_atomic` | League > Commissioner > Action / 3 |
| `/league/playoff-fit` | league | Commissioner; read-only playoff span check against the current season's weeks | League > Commissioner > Action / 3 |
| `/league/lineup/auto-set-season` | league | Own member in league; internal `lineup-optimizer` | Home > Rest of season / 1 |
| `/waivers/claims` | [waivers](../supabase/functions/api/waivers.ts) | Own member; `create_waiver_claim_atomic` | Home > Find a player to claim > Claim / 2; submit / 3 |
| `/waivers/claims/:claimId/cancel`, `/edit`, `/reorder` | waivers | Own member; `cancel_waiver_claim_atomic`, `edit_waiver_claim_atomic`, `reorder_waiver_claim_atomic` | Home > Manage claims > Claim action / 2 |
| `/waivers/process` | waivers | Commissioner; internal `process-waivers` | League > Commissioner > Action / 3 |
| `/trades/propose`, `/trades/propose-multi` | [trades](../supabase/functions/api/trades.ts) | Own proposer; `submit_trade_offer_atomic` | Trades > Propose / 2 |
| `/trades/:tradeId/counter`, `/counter-multi`, `/edit`, `/edit-multi` | trades | Authorized trade actor; `submit_trade_offer_atomic` | Trades > Offer > Action / 3 |
| `/trades/:tradeId/accept` | trades | Trade participant; `accept_trade_atomic` or `accept_trade_with_plan_atomic` | Trades > Offer > Action / 3 |
| `/trades/:tradeId/reject`, `/withdraw`, `/veto` | trades | Action-specific participant/league authority; corresponding `*_trade_atomic` RPC | Trades > Offer > Action / 3 |
| `/trades/:tradeId/roster-plan`, `/taxi-destinations` | trades | Own member; `set_trade_roster_plan_atomic`, `set_trade_taxi_destinations_atomic` | Trades > Offer > Action / 3 |
| `/trades/block`, `/trades/block/:itemId/remove` | trades | Own member; `add_trade_block_item_atomic`, `remove_trade_block_item_atomic` | Trades > Block > Asset action / 3 |
| `/draft/start`, `/draft/start-rookie` | [draft](../supabase/functions/api/draft.ts) | Commissioner; `start_auction_draft_atomic`, `start_rookie_draft_atomic` | League > Draft setup and mock rooms > Action / 3 |
| `/draft/rookie-start-warning` | draft | Commissioner; read-only `draft_timer_start_warning` opening-night estimate | League > Draft setup and mock rooms > Action / 3 |
| `/draft/mock-room/create` | draft | Own member; `create_mock_draft_room_atomic` | League > Draft setup and mock rooms > Action / 3 |
| `/draft/:draftId/join-mock-room`, `/leave-mock-room`, `/start-mock-room`, `/delete-mock-room` | draft | Own member and room rules; corresponding mock-room atomic RPC | League > Draft setup and mock rooms > Room action / 3 |
| `/draft/:draftId/stop`, `/reset`, `/pause`, `/resume` | draft | Commissioner; corresponding draft atomic RPC | League > Draft Room > Controls > Action / 4 |
| `/draft/:draftId/nominate`, `/bid`, `/withdraw-nomination` | draft | Own member; auction nomination/bid atomic RPCs | League > Draft Room > Action / 3 |
| `/draft/:draftId/snake-pick`, `/auto-pick`, `/process-expired-pick` | draft | Own member; `make_snake_pick_atomic`, `auto_pick_snake_pick_atomic`, `process_expired_snake_pick_atomic` | League > Draft Room / 2; deadline processing runs automatically |
| `/draft/:draftId/commissioner-pick` | draft | Commissioner; `commissioner_snake_pick_atomic` | League > Draft Room > Action / 3 |
| `/draft/:draftId/activate-rookie-league` | draft | JWT and SQL actor checks; `activate_rookie_draft_league_for_user_atomic` | League > Draft Room > Action / 3 |
| `/draft/:draftId/reseed-picks` | draft | Commissioner; `reseed_rookie_draft_picks_atomic` | League > Draft setup and mock rooms > Action / 3 |
| `/draft/:draftId/close-expired` | draft | Draft league member; `close_expired_auction_nominations_atomic` | League > Draft Room / 2; deadline processing runs automatically |
| `/draft/:draftId/pause-for-absence`, `/resume-if-absent` | draft | Commissioner; `pause_draft_for_absence_atomic`, `resume_draft_if_absent_atomic` | League > Draft Room > Controls > Action / 4 |
| `/playoffs/generate`, `/playoffs/advance` | [playoffs](../supabase/functions/api/playoffs.ts) | Commissioner; `generate_playoff_bracket_atomic`, `advance_playoff_bracket_atomic` | League > Playoffs > Action / 3 |

Abbreviated action paths retain the full prefix from the first path in their row.
Database time and server checks decide auction and rookie deadlines. Browser clocks only display those deadlines.

### Admin and E2E routes

| Route | Access | Operation |
| --- | --- | --- |
| `POST /sync/matchups` | Admin or league commissioner | `replace_regular_season_matchups_atomic`; existing schedules return HTTP 200 with `ok: true, skipped: true` unless forced |
| `POST /sync/stats` | Admin | `create_or_resume_stats_sync_job_atomic`; queued range processing |
| `POST /sync/scores`, `/schedule`, `/players`, `/rankings`, `/projections`, `/draft-order` | Admin | Corresponding internal `sync-*` function |
| `POST /sync/backfill`, `GET /sync/backfill/:jobId` | Admin | Start backfill or read progress |
| `POST /sync/test-endpoints`, `/verify-stats`, `/validate-db`; `GET /sync/season-totals` | Admin | Internal `verify` actions |
| `/e2e/*` | `x-e2e-secret` | Explicit test hooks; [E2E handler](../supabase/functions/api/e2e.ts) defines methods and actions |

[Sync routing](../supabase/functions/api/sync.ts) uses `ADMIN_USER_IDS` for admin authorization.
Internal Edge functions have separate dispatch authentication. They are not public client mutation endpoints.
The [Edge inventory check](../scripts/check-edge-functions.mjs) compares configured functions with executable entrypoints.

## Navigation feature map

Tap counts measure entry from an authenticated Home screen. Scrolling and text entry do not add route taps.
Confirmation taps are shown when the map names a completed action. Role and season rules still apply.
The source audit covers every app route and each client action family listed below.
WebKit checks pass for 33 screens per account at 390×844. Manager and commissioner accounts cover all 25 app routes.
Thirty-five entry checks pass, including two-tap lineup moves and one-tap claim editing. The map retains source counts for other actions.
Thirty-one measured controls meet the 44-pixel target. Visible inputs meet 16 pixels. Safe areas pass on every captured screen.
Screenshots and receipts live under `program2/evidence/navigation/round3/`.

| Feature | Entry from Home | Taps | What appears |
| --- | --- | --- | --- |
| Live matchup | Home | 0 | Live scores, win odds and remaining games |
| Manual lineup swap | Home > Player > Destination | 2 | Legal targets; started players stay locked |
| Auto-set today / this week / rest of season | Home > Period action | 1 | Shared lineup action and its saved result |
| Automatic lineup preference | Home > Keep updated automatically | 1 | Saved team preference; manual lineups stay unchanged |
| Pending claims / next run / FAAB | Home | 0 | Pending count, scheduled run and available balance |
| Claim form | Home > Find a player to claim > Claim | 2 | Bid, drop and destination controls |
| Submit claim | Home > Find a player to claim > Claim > Submit | 3 | Server confirmation or actionable error |
| Edit pending claim | Home > Edit claim | 1 | Saved bid, drop and destination |
| Cancel or reorder claims | Home > Manage claims > Cancel or reorder | 2 | Current claim order and cancellation control |
| Rankings / News | Players > Rankings or News | 2 | Ranking views, news filters and player links |
| Player details and history | Players > Player > Detail section | 3 | Stats, projection, game log, news and transactions |
| IR / taxi / drop | Roster > Player > Action | 3 | Roster action with current server checks |
| Trade proposal | Trades > Propose | 2 | Multi-team composer with players, picks and FAAB |
| Trade edit / counter / accept / reject / withdraw / veto | Trades > Offer > Action | 3 | Current offer and legal action |
| Trade roster plan / taxi destinations | Trades > Offer > Roster plan | 3 | Required outgoing drops and reserve destinations |
| Trade history / block | Trades > History or Block | 2 | Past offers or league listings |
| Trade analysis | Trades > Offer > Analyze | 3 | Trade impact and projections |
| Trade block add / remove / note | Trades > Block > Asset | 3 | Owned asset listing control |
| League standings / record | League > Standings | 2 | Team records and standings |
| League activity / announcements | League > Activity | 2 | League events and announcement history |
| Picks / draft board | League > Picks and draft board | 2 | Current and future pick ownership |
| League rules / invite / waiver order | League > League settings | 2 | League rules, invite action and waiver priority |
| Playoffs / generate / advance | League > Playoffs > Action | 3 | Bracket and eligible round action |
| Draft start / rookie warning / reseed | League > Draft setup and mock rooms > Action | 3 | Setup and timer controls with opening-night warning |
| Mock room create / join / leave / start / delete | League > Draft setup and mock rooms > Room action | 3 | Room list and eligible owner actions |
| Auction nominate / bid / withdraw | League > Draft Room > Action | 3 | Live deadline, current bid and available budget |
| Rookie pick / auto-pick / commissioner pick | League > Draft Room > Action | 3 | Pick clock, eligible prospects and pick controls |
| Draft stop / reset / pause / resume | League > Draft Room > Controls > Action | 4 | Eligible commissioner controls |
| League configuration / scoring / member control | League > Commissioner | 2 | Rules, scoring and authorized member actions |
| Season advance / schedule / waiver processing / playoff fit | League > Commissioner > Action | 3 | Lifecycle action and its server checks |
| Publish announcement | League > Commissioner > Announcement | 3 | Announcement form |
| Profile / team / avatar | League > Profile & settings > Edit | 3 | Editable profile and team name |
| Notification preferences / push controls | League > Notifications | 2 | Preference switches and device controls |
| Password / league create / league join | League > Account action | 2 | Selected account form |
| Sign out | League > Profile & settings > Sign out > Confirm | 4 | Sign-out confirmation |
| Season timeline | Home > Timeline or League > Season timeline | 1–2 | Team events or a load error with retry |

Public health, images, clock processing and scheduled jobs run automatically. They need no hidden user gesture.
Admin sync, verification and E2E endpoints have no manager or commissioner screen. They remain operations tools.
The timeline screen shows team events. Route tests cover loading and retry after a failed import.
Loaded named and default exports, route rendering and retry pass focused tests.

## Measurement rules

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
Record standalone emulation separately and compare identical WebKit modes.
Exclude segments contaminated by the next workflow's setup. Local timing and byte counts do not establish hosted latency or egress cost.

## Images and scheduled work

The web avatar defers offscreen images and falls back to initials after failure.
Measure successful image responses separately from absent or malformed identities.
Logical cache hits do not establish transferred bytes.

[Source monitoring](source-monitoring.md) owns scheduling, invocation reconciliation, retry, and retention rules.
