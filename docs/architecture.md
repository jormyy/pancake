# Architecture

Pancake separates browser presentation, shared calculations, and database rules. This document maps those boundaries and the data flow between them.

## Screen views

Each screen can read one JSON row through its SQL function.
The optional `GET /views/<screen>` route returns `{ ok, view }`.
Existing client reads remain available until the client switches.
Each function accepts `p_league_id`, `p_member_id`, and `p_params`.
Profile also works without a league.
The database checks the signed-in user against the member.
Claims include only that member's bids.
Cached trade analysis follows the trade's read policy.
The Edge route forwards the user's bearer token to each view RPC.

The table counts top-level JSON keys, including `context`.
Each function returns one database row.
Before counts are source estimates for cold reads, excluding auth and shared league selection.
Ranges depend on populated rosters, claims, and live games.
After counts describe the new contract; existing clients still use their current reads.
Times are single SQL observations on a private fixture with three teams, one roster player, one game, one private trade, and one mock room.
They exclude network time and do not establish a production latency bound.
These observations precede the missing-calendar lineup fallback change.
That change awaits a private database check.

| Screen | SQL function | Fields | Before → after requests | SQL ms | Main payload |
| --- | --- | ---: | --- | ---: | --- |
| Home matchup | `view_home` | 13 | 12–16 → 1 | 6.17 | Matchup, both lineups, week days, league matchups, forecast, announcements, live stats, game state |
| Roster | `view_roster` | 11 | 9–12 → 1 | 3.18 | Roster, picks, own claims, average maps, priority, FAAB, limits, slots, taxi exits |
| Players and Waivers | `view_players` | 10 | 6–8 → 1 | 14.09 | Search page, ownership, waiver times, own pending claims, limits, visible totals |
| Player page | `view_player` | 17 | 9–12 → 1 | 9.30 | Player, seasons, averages, game log, live game, fantasy map, projection, history, roster context |
| Trades: offers | `view_trades` | 7 | 4–6 → 1 | 7.74 | Offers, cursor, block, members, incoming count |
| Trades: history | `view_trades`, `tab=history` | 7 | 4–6 → 1 | 7.74* | Member history and cursor |
| Trades: block | `view_trade_block` | 7 | 5–7 → 1 | 2.27 | Block assets, own roster, picks, average maps |
| Trade details | `view_trade_details` | 5 | 4–7 → 1 | 9.66 | Trade, participants, routed assets, saved quote, roster plans, current analysis |
| Trade analysis | `view_trade_analysis` | 5 | 1 → 1 | 2.89 | Stored revaluation and its stale flag |
| League: standings | `view_standings` | 2 | 3 → 1 | 0.33 | Sorted regular-season records and totals |
| League: activity | `view_activity` | 5 | 2–3 → 1 | 1.18 | Activity page, player metadata, announcements, offset |
| League: picks | `view_picks` | 2 | 1 → 1 | 0.09 | Unused picks and both owner names |
| League: settings | `view_settings` | 4 | 2 → 1 | 0.78 | League settings, waiver order, lineup templates |
| League: draft rooms | `view_draft_rooms` | 3 | 1 → 1 | 0.93 | Mock rooms, participants, room state, current real drafts |
| League tab wrapper | `view_league` | 2–5 | 1–3 → 1 | 0.28 | Selected tab's payload |
| Lineup editor | `view_lineup` | 13 | 7–10 → 1 | 1.34 | Slots, reserves, week days, optimizer, games, live stats, started teams |
| Claim editor | `view_claim_editor` | 13 | 8–12 → 1 | 19.27 | Player, roster, own claims, priority, clearing time, limits, members, taxi exits |
| Auction room | `view_draft_room` | 11 | 5–7 → 1 | 1.82 | Draft, order, budgets, nominations, active bids, current nominator |
| Rookie draft room | `view_draft_room` | 11 | 3–4 → 1 | 1.82* | Draft, order, picks, skipped picks, next pick |
| Profile | `view_profile` | 3 | 1–2 → 1 | 0.44 | Public profile fields and own notification preferences |

`*` marks a shared function timing; that tab or draft variant has no separate timing sample.
The League wrapper accepts `results`, `history`, `picks`, `draftBoard`, `settings`, `draft`, and `mockRooms`.
Trade history uses `tab=history` and the returned `nextCursor.token`.
The token belongs to this view contract.
Player and claim pages require `playerId`; trade pages require `tradeId`; draft rooms require `draftId`.
List parameters include `limit`, `offset`, `query`, `position`, `teams`, `health`, `sortBy`, and `sortDir`.
Player search also accepts inclusion, exclusion, playing-team, rookie, and availability filters.
Lineups accept `date`, `weekNumber`, and `targetMemberId`.
Season selection uses `seasonYear` or a league-owned `seasonId`.
JSON objects replace client Maps; arrays replace Sets.
The client can restore those containers without another request.

Player pages return at most 100 season lines and initially show 15 games.
Player search returns 20 rows by default and at most 50, with visible totals for that page.
Claims include all pending entries and the last 20 resolved entries.
Activity pages contain at most 100 rows and 50 announcements.
Trade pages contain at most 99 trades and return a cursor.
Room lists contain at most 60 mock rooms.
Auction rooms include at most 500 nominations and 100 active bids.
Roster, pick, slot, participant, and snake-pick arrays follow the league's stored limits.

`standings_current`, `matchup_totals`, `player_season_averages`, and `trade_value_cache` store versioned results.
The migration fills existing standings, totals, and averages before exposing the views.
`matchup_forecasts` continues to store win odds.
Standings exclude unfinished, voided, and playoff matchups.
Offseason rosters use the latest league season.
Player averages preserve the existing statistics and fantasy-average precision.
Before a league rolls over, current NBA averages can use the existing stored totals as a fallback.
Current-season player search reads stored averages instead of grouping game stats on each request.
Trade revaluation uses the existing trade model and preserves its input version.
An unsaved trade uses the Edge analysis route with `params.items` and returns the existing quote format.

The minute job dispatches `refresh-views` when work is pending.
Change hints, matchups, rosters, settings, members, seasons, trades, templates, and optimizer settings queue work.
Each change advances the league-season version.
Workers claim leases and compute trade values outside the publication transaction.
Publication checks the lease token, claimed version, and complete valuation set.
An old worker cannot overwrite newer inputs.
Repeated refreshes preserve row values and timestamps.
Expired leases retry after three minutes.
Trade values expire within ten minutes and queue another refresh.
Missing historical inputs produce an unavailable result; transport failures retry the job.
Responses report the input version and stale state in `context`.

The database recipes cover empty leagues, midweek scores, playoffs, offseason rosters, privacy, stale publication, and repeated refreshes.
Search parity compares every result field across ten sort columns, both directions, and four health filters.
A deliberately corrupted cached average must fail that comparison.
The route check proves one view RPC for each of the 18 route names.
The worker check compares its trade output against the existing model.

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/view-screen-parity.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/view-player-search-parity.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/view-lineup-fallback.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/refresh-screen-cache.sql
deno test --allow-env --allow-net --allow-read supabase/functions/api/views.test.ts supabase/functions/refresh-views/work.test.ts
npm run check:db-function-sources
npm run check:db-function-catalog
npm run check:database-types
```

Run database recipes and generation against the private local stack.
Run `npm run check:edge-functions` without the database test environment, as described in the verification guide.
The job also adds one entry to `supabase/config.toml` and the simulator's cron catalog.
Database types, function ownership records, and release audit records come from the migrated private stack.

## Code map

| Concern | Source | Contract |
| --- | --- | --- |
| Screens and navigation | `app/`, `components/`, `hooks/` | Expo Router and web components |
| Public startup | `constants/boot-shell.ts`, `app/+html.tsx`, `public/sw.js` | [PWA and loading](pwa-live-data.md) |
| Client data | `lib/` | Auth, PostgREST, RPCs, Edge API, and Realtime |
| Edge API | `supabase/functions/api/` | [Backend boundaries](supabase-backend-route-inventory.md) |
| Database rules | `supabase/sql/functions/by-name/` | Canonical function sources |
| Published schema | `supabase/migrations/` | Immutable ordered migrations |
| Shared rules | `core/`, `supabase/shared-src/` | Generated app, Edge, and SQL copies |

Run `npm run check:edge-shared`, `npm run check:core-cjs`, and `npm run check:db-function-sources` to check source parity.

## Auth and saved content

The boot shell reads the configured project's session and logout markers before showing saved identity.
An expired token does not authorize data reads.
Online restoration waits for refresh while the page is visible.
Membership reads confirm the saved league choice before actions become available.
Sign-out and account changes clear private caches and fence late responses.

Saved screen content helps startup and route returns.
It does not establish membership, locks, eligibility, or write permission.
Each loader owns its freshness and refresh rules.

## Change hints

`lib/league-changes.ts` shares one authenticated stream for the selected league.
Topics cover lineups, rosters, scores, games, stats, inventory, and resources.
Hints contain scope keys and revisions, not player rows or box scores.
Clients read authoritative data after a change.
Missing revisions, malformed details, overflow, and reconnects require broader reads.
Hidden or offline consumers retain pending work until they can read again.

Inventory hints cover picks, claims, waiver entries, priority, FAAB, and season changes.
Resource hints cover averages, projections, and scoring settings.
Live stats read displayed players and keep a safety poll.
The live fallback polls more often when the hint stream disconnects.

## League rules

Lineups distinguish starters from bench players. IR and taxi have separate capacity limits.
Auto-set daily starts enabled for new teams. Later seasons preserve the manager's choice.
See [lineup automation](pre-tipoff-lineups.md).

Commissioners can configure team limits, playoff entrants, and each playoff round's week length.
Configured brackets use seeded elimination with first-round byes for top seeds.
Odd-team leagues receive regular-season byes.
Skipped regular weeks retain marked history and do not affect standings.
See [roster, trade, and season rules](roster-lifecycle.md).

The public activity feed shows completed transactions and announcements, without pending trade offers or trade-block changes.
Private offers remain in Trades.
Commissioner announcements appear in a dismissible Home banner and League > Activity.
Home shows the newest announcement from another member in the last 14 days.
It must be newer than the last dismissed announcement.
Announcements that arrive while Home stays open appear on pull, retry, or return.
Dismissal applies to that manager and league on the current device.
Dismissal leaves the Activity entry available.
Announcement reads preserve cached Home content and visible errors without layout shifts or flicker.

## Season transitions

The season-boundary worker creates playoffs after the regular season finishes.
Advancement waits for final results and the stat-correction grace period.
Consumed rounds stay frozen.
Rollover preserves history, resets season balances, and prepares the rookie draft and new schedule.
An unrun rookie draft has a best-available fallback before the new season activates.
Invalid calendars remain errors. An unpublished next calendar causes a retry.

The [historical simulator](season-simulator.md) exercises ingestion and season transitions.
The [verification guide](verification.md) lists the focused database checks.

## Claims and trade decisions

Every available player enters through a scheduled FAAB claim.
The database freezes claim changes at the daily cutoff and settles ownership, drops, balances, and priority together.
Trade plans reserve assets and capacity across all accepted trades.
Settlement checks resulting rosters before applying every transfer and retained-player move in one transaction.
[Roster lifecycle](roster-lifecycle.md) owns those rules.

The Edge API computes trade estimates from database-owned league inputs and shared dynasty calculations.
Offer submission attaches the frozen quote in the same transaction.
Historical revaluation reads saved routes with current inputs and leaves the original quote unchanged.
[Trade estimates](trade-estimates.md) owns quote expiry, authorization, and saved views.

The `matchup-forecast` Edge worker computes shared forecasts outside screen loads.
Database triggers queue changed inputs, and revision tokens reject obsolete results.
Clients read member-authorized cached forecasts and show coverage and stale state.
[Matchup forecasts](matchup-forecasts.md) owns model limits and publication locks.

## Projection data

`get_league_projection_rows` supplies player views, lineup optimization, and matchup forecasts.
Sleeper sync selects the scoring week containing today's Pacific date.
A day outside every scoring week records a successful skip without fetching or changing projections.
[Source monitoring](source-monitoring.md#projection-readers) owns provider precedence, freshness, and storage rules.
[PWA behavior](pwa-live-data.md#player-detail) owns the player detail layout.

## Scheduled work

Cron calls guarded database dispatch functions through pg_net.
Workers record outcomes in sync records; reconciliation compares those outcomes with transport responses.
Due-work gates skip idle calls. Leases and receipt tokens fence retries.
See [source monitoring](source-monitoring.md) for schedules, retries, and retention.
