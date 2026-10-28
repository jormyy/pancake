# Architecture

Pancake separates screen rendering, shared calculations, and database rules.
PostgreSQL owns authorization, roster legality, scoring, and committed state.

## Screen views

Screen loaders read one complete JSON view through `GET /views/<screen>`.
The Edge API forwards the user's bearer token to member-scoped SQL reads.
Most routes call one view function.
Other-matchup views combine authorized reads on the server.
The response is `{ ok, view }`.
The browser restores Maps and Sets from JSON without extra reads.
Authentication, league selection, and the shared change stream have separate reads.

| Screen | SQL reader | Contents |
| --- | --- | --- |
| Home matchup | `view_home` | Teams, lineups, scores, game state, forecast, and league dates |
| Other matchup | `view_home` plus server-side detail reads | Selected teams and day, with membership checks |
| Roster | `view_roster` | Players, birthdates, picks, claims, limits, slots, FAAB, and priority |
| Players and Waivers | `view_players` | Filtered player page, ownership, claims, and visible totals |
| Player detail | `view_player` | Identity, seasons, games, projections, history, and roster context |
| Trades and history | `view_trades` | Offers or history, members, and cursor |
| Trade block | `view_trade_block` | Listings, roster, picks, and average maps |
| Trade details | `view_trade_details` | Routes, participants, quote, roster plans, and current analysis |
| Trade analysis | `view_trade_analysis` | Stored revaluation and stale state |
| League | `view_league` | Selected section from standings, activity, picks, settings, or drafts |
| Lineup editor | `view_lineup` | Slots, reserves, dates, optimizer settings, and game locks |
| Claim editor | `view_claim_editor` | Player, roster, claims, clearing time, limits, and destinations |
| Draft room | `view_draft_room` | Auction or rookie order, bids, picks, and current turn |
| Profile | `view_profile` | Public profile and the user's notification preferences |

Views check the current member and league.
Profile also works without a league.
Claims expose only the caller's bids.
Trade analysis follows the trade's read policy.
Parameters select the season, date, target member, detail ID, page, or search filters.
The database returns bounded lists and cursors.
Details and later pages load when requested.

Home uses the league's calendar date and timezone.
Scoring retains NBA game dates.
Home shows the matchup in one vertical scroller.
Other matchups open a separate detail page.

## Versioned cache and push invalidation

The screen cache stores schema, scope, league version, saved time, and data.
Keys include account, league, member, season, screen, and normalized parameters.
Current-season lookups resolve to a stored season ID.
The cache holds at most 48 entries and 4 MiB of JSON.

Saved content renders immediately.
A clean cached screen reopens with zero screen requests before its background check.
A cold screen reads one view without a separate version request.
The rookie draft controller also checks the league version.
Foreground return, reconnect, and background checks reconcile the shared league version.
An unchanged version needs no new view.
Changed topics invalidate affected views.
Missing ranges require a fresh view.
Hidden screens defer reads until active.

`league_versions` advances once per changed league transaction.
`league_changes` keeps the last 128 entries per league.
`GET /version?league=<uuid>&since=<decimal>` returns the counter and changes.
Counters travel as decimal strings.
The existing authenticated `league_change_hints` stream carries version notifications.
There is no second channel for version delivery.

Account changes clear private caches and reject late replies.
League selection clears screen results before changing the selected member.
Offline screens retain saved data and show an offline notice.
The service worker caches public files separately from private screen data.
See [loading](instant-loading.md) and [PWA behavior](pwa-live-data.md).

## Stored results and background refresh

`standings_current`, `matchup_totals`, `player_season_averages`, and `trade_value_cache` store screen results.
Changes mark the league-season refresh queue dirty.
`refresh-views` claims one season and computes at most 20 trade valuations per run.
Incomplete valuation sets leave work for a later run.
Publication checks the claim token and input version.
An old worker cannot replace newer results.

Hash and exact-content comparisons skip unchanged cache writes.
Trade publication freshness lives separately from the analysis JSON.
Changed result fields publish a new league version.
Refresh timestamps alone do not publish another version or restart refresh work.
Views expose stale state while work remains pending.
Trade values expire within ten minutes.

## Idempotent writes

The client gives each logical write one request UUID.
Retries and offline replay preserve that UUID and the original input.
`private.request_receipts` binds the result to the actor, function, and input hash.
A repeated request returns its saved result without repeating effects.
A changed actor or payload cannot reuse the receipt.
Receipts expire after seven days.

The persistent offline queue stores account, league, affected rows, input, and request ID.
It stores no bearer token.
Reconnect replays actions in order with the matching current account.
A failed action blocks later actions until retry.
Pending rows stay marked until the server accepts the action.
The server rechecks membership, locks, ownership, and legality when it executes each write.

## League rules and history

Every available player enters through scheduled FAAB claims.
There are no instant pickups.
Awards commit ownership, conditional drops, FAAB, priority, and add counts together.
Historical lineup locks survive roster moves and missing game metadata.
Rookie drafts default to linear order.
Tied records use higher points per game before the stored seed.

Every trade requires legal resulting rosters before acceptance and settlement.
Plans reserve outgoing assets, retained-player moves, drops, and incoming capacity.
Settlement applies all participants' changes atomically.
The Activity section records trade transitions with privacy rules for pending offers.
Private team timelines project events from `league_events`.
See [roster lifecycle](roster-lifecycle.md) and [drafts](draft.md).

## Trade estimates and forecasts

The Analyzer requests current estimates through the Edge API.
A supplied valid quote attaches in the offer transaction.
Without a quote, the offer commits first and queues an estimate.
The internal estimate worker reads the saved routes and attaches the result later.
Estimate failure leaves the valid offer intact.
Identical pending offers are rejected separately from request replay.
Trade event and screen publication can run after the trade write commits.

The `matchup-forecast` worker computes shared forecasts outside screen loads.
It prepares bounded player histories and projection inputs before reading the forecast context.
Stored season totals update projection inputs when statistics change.
Revision tokens reject old results.
Expiry is the next known tipoff or six hours.
See [trade estimates](trade-estimates.md) and [matchup forecasts](matchup-forecasts.md).

## Scheduled work

One SQL dispatcher owns the application work queue.
`work-dispatcher` calls `public.dispatch_work()` each minute.
Two maintenance cron entries drain hints every 30 seconds and prune cron history hourly.
Old per-job Edge cron dispatchers are removed.

The dispatcher checks the operator pause before enqueueing or claiming work.
It claims one item at a time, with at most eight claims and eight active workers.
It starts no new item after two seconds.
The cron command sets a five-second statement budget and a 250 ms lock budget.
Service-role statements have a three-second budget and a 250 ms lock budget.
An advisory lock skips overlapping dispatch runs.

Claims grant five-minute work leases.
Workers renew every 30 seconds and at explicit work phases.
Lease loss stops further writes.
Retries back off from one minute to a fifteen-minute cap.
The third failed attempt becomes dead work.
Individual game and forecast claims retain their own ownership checks.

`work_dashboard()` shows due, running, failed, and dead work.
`set_worker_paused(true, reason)` stops new scheduled work.
The pause does not cancel a running statement.
The [operator runbook](../supabase/RELEASE-DB.md#worker-incident-controls) covers pause, inspection, and resume.

## Events, retention, and beacons

`league_events` stores product outcomes and terminal work outcomes.
Global work events remain backend-only.
Member-scoped readers protect failed claims and private trade details.
Repeated terminal updates do not add duplicate events.

Daily queued retention starts after 10:00 UTC.
It skips locked rows and starts no new helper after two seconds.
Most helpers delete at most 5,000 rows per call; session cleanup caps at 500.
Cron history keeps 24 hours and preserves active executions.
Request receipts keep seven days; performance beacons keep thirty days.
Durable product history and failed work retain separate lifetime rules.
`retention_dashboard()` reports rules, sizes, cleanup totals, and errors.

The client batches sampled screen timings at `/beacons`.
It sends at most once per minute and drops empty or offline batches.
The endpoint accepts at most 20 samples per request.
Backend-only summaries support performance review.
[Source monitoring](source-monitoring.md) owns schedules and retention details.
[IO audit](io-audit.md) records measured reductions and their limits.

## Code map

| Concern | Source |
| --- | --- |
| Screens and navigation | `app/`, `components/`, `hooks/` |
| Client cache and transport | `lib/` |
| Edge routes and workers | `supabase/functions/` |
| Current SQL functions | `supabase/sql/functions/by-name/` |
| Ordered schema changes | `supabase/migrations/` |
| Shared calculations | `core/`, `supabase/shared-src/` |

[Verification](verification.md) lists source, database, browser, and release checks.
