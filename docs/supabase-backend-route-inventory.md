# Backend route inventory

This reference maps current request ownership and authorization.
Screen request counts exclude shared Auth, membership, image, and stream traffic.

## Runtime boundaries

| Boundary | Purpose | Authority |
| --- | --- | --- |
| Supabase Auth | Sign-in, refresh, sign-out, and passwords | Current session |
| Edge screen views | One complete response for a screen | User token and member-scoped SQL |
| PostgREST tables and RPCs | Supporting resources, team timeline, and guarded writes | Database grants, RLS, and function checks |
| Edge actions | Trades, claims, drafts, push, and league actions | Route and database checks |
| Realtime | Shared league versions and draft state | Authenticated channel access |
| Storage | Avatar upload and public image reads | Upload ownership and public image rules |
| App origin and worker | Documents, scripts, fonts, and public files | Stamped public asset manifest |

The service worker excludes private backend responses and cross-origin images.
Private screen snapshots use separate account-scoped storage.
Measure HTTP requests and WebSocket frames separately.

## Client route inventory

The [architecture](architecture.md#screen-views) lists the SQL readers.
The [loading contract](instant-loading.md) defines cold reads and zero-request cached returns.

| Route or section | Read contract | Actions |
| --- | --- | --- |
| `/sign-in`, `/sign-up` | Auth state and public form | Sign in or create account |
| `/` | `home` screen view | Compare lineups, choose date, open player or auto-set |
| `/matchup` | `home` view with selected matchup ID | Inspect another matchup and date |
| `/roster` | `roster` screen view | Moves, drops, picks, and pending claims |
| `/players` | `players` screen view | Search and open claim form |
| Players > Waivers | `players` view and own claims | Create, edit, reorder, or cancel claims |
| Players > Rankings | Shared dynasty snapshot | Select ranking view and inspect player |
| Players > News | Bounded news resource | Filter news and open source article |
| `/dynasty` | Redirect to Rankings | No separate legacy screen |
| `/trades` | `trades` screen view | Offers, responses, and history |
| Trades > Block | `trade-block` screen view | Add, remove, or edit owned listings |
| Trades > Analyzer | Estimate and revaluation API | Compare selected assets |
| `/league` | `league` view for selected section | Standings, Activity, Picks, Draft, Bracket, Settings |
| `/draft`, `/draft-room`, `/rookie-draft-room` | Draft launcher and `draft-room` view | Auction, picks, timer, and commissioner actions |
| `/profile` | `profile` screen view | Profile, team name, avatar, and sign-out |
| `/notification-settings` | Shared preferences | Preferences and device push controls |
| `/player/:id` | `player` screen view | Roster controls, watch state, and cached game paging |
| `/lineup` | `lineup` screen view | Slot changes, auto-set, and automatic preference |
| `/team-roster` | Selected member's roster view | Player navigation |
| `/claim-player` | `claim-editor` screen view | Bid, drop, and destination choices |
| `/propose-trade` | Composer resources and roster previews | Propose, edit, or counter with a legal plan |
| `/bracket` | Bracket resource | Inspect rounds and eligible commissioner actions |
| `/commissioner-settings` | Settings resources | Rules, lifecycle, members, and announcements |
| `/create-league`, `/join-league`, `/change-password` | Shared session | Selected account action |
| `/timeline` | `view_team_timeline` RPC | Team event filters and claim history |

Other-matchup data stays one client request.
The Edge handler combines the authorized Home, lineup, standings, forecast, and matchup reads.
Legacy League section parameters still resolve to current sections.
Cold details and explicit pagination can make new requests.
A cold screen view is not a complete page-network budget.

## Read bounds and refresh

Player search returns 20 rows by default and at most 50 per view.
Player detail carries at most 100 game rows and reveals 15 at a time.
Revealing a cached game page adds no request.
Trade pages carry a bounded list and cursor in one response.
They do not fetch each selected trade again in the browser.
Activity returns bounded events and announcements.
Selected trade details load when opened.

Version changes invalidate affected screens.
Foreground return and reconnect check the shared version.
Hidden and offline screens defer their reads.
Unknown topics or missing change ranges require a broader refresh.
Saved membership never authorizes a write.
The server checks current ownership, membership, locks, and legal plans.

## Edge API routes

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
| `/league/roster/ir`, `/league/roster/taxi` | [league](../supabase/functions/api/league.ts) | JWT and roster ownership; `toggle_ir_atomic`, `toggle_taxi_atomic` |
| `/league/advance-season` | league | Commissioner; `advance_season_atomic` |
| `/league/playoff-fit` | league | Commissioner; read-only playoff span check against the current season's weeks |
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
| `/draft/rookie-start-warning` | draft | Commissioner; read-only `draft_timer_start_warning` opening-night estimate |
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


### Current screen and background routes

| Route | Access and result |
| --- | --- |
| `GET /views/<screen>` | Authenticated member-scoped complete view |
| `GET /version?league=<uuid>&since=<decimal>` | Current member; league version and bounded changes |
| `POST /beacons` | Own member; at most 20 validated timing samples |
| `POST /trades/estimate` | Own member; current estimate for exact routes |
| `POST /trades/:tradeId/revalue` | Authorized trade reader; separate current calculation |
| `POST /trades/:tradeId/roster-preview` | Authorized trade reader; resulting roster preview |
| `POST /trades/estimate-work` | Internal authentication; attach queued offer estimate |
| `POST /trades/activation-work` | Internal authentication; queued league activation |

## Navigation feature map

Home opens the matchup.
League opens Standings.
Players and Trades restore their last selected section.
Section bars use a background highlight without an underline.

| Feature | Current entry |
| --- | --- |
| Live matchup | Home |
| Other matchup | Home > Other matchups > Matchup |
| Manual lineup move | Home > Player or slot > Destination |
| One-time auto-set | Home or Roster > Auto-set > Period |
| Automatic lineup preference | Auto-set sheet or lineup editor |
| Claims and next run | Roster > Waivers pill or Players > Waivers |
| New claim | Players > Player > Claim |
| Edit, cancel, or reorder claim | Players > Waivers > Claim action |
| Propose or respond to trade | Trades > Offers > Action |
| Trade block | Trades > Block |
| Trade history | Trades > History |
| Trade Analyzer | Trades > Analyzer |
| Standings, Activity, Picks, Draft, Bracket, Settings | League > Named section |
| Commissioner tools, invite, notifications, profile | Hamburger menu > Named entry |
| Team timeline | Claim history link or direct `/timeline` route |

The current Home screen has no timeline or daily waiver card.
Trade cards have no timeline link.
Role, season, and roster rules can disable actions.
Use `tests/e2e/surface-matrix.json` for the executable route and scenario coverage map.
Historical capture counts do not establish coverage for a later build.

## Measurement rules

Record source, fixture, browser, viewport, mode, and worker state.
Separate cold loads, cached returns, HTTP-cache hits, and worker responses.
Count shared shell requests once.
Keep setup and teardown outside the measured action.
Record methods, safe parameters, status, row counts, bytes, and timing.
Exclude credentials, Auth bodies, and private response rows from traces.
Measure WebSocket frames separately from HTTP.
Use matching actors, fixtures, cache states, and visibility for comparisons.
Check changed data after reconnect; fewer requests alone do not prove freshness.

Assert actual offline and hidden state at the request boundary.
Some Chromium offline controls block HTTP while `navigator.onLine` remains true.
Reject such traces as offline evidence.
Reject image samples that contain only failures.
WebKit phone emulation does not prove physical-device suspension behavior.
[Source monitoring](source-monitoring.md) owns worker schedules, retries, and retention.
