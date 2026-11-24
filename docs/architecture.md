# Architecture

Pancake has three layers.
The Expo client renders screens and keeps a local cache.
Supabase Edge functions handle HTTP routes and background workers.
PostgreSQL owns authorization, league rules, scoring, and committed state.
`core/` holds calculations that the client, Edge, and tests share.

## Code map

| Concern | Source |
| --- | --- |
| Screens and navigation | `app/`, `components/`, `hooks/` |
| Client cache and transport | `lib/` |
| Edge routes and workers | `supabase/functions/` |
| Current SQL functions | `supabase/sql/functions/by-name/` |
| Ordered schema changes | `supabase/migrations/` |
| Shared calculations | `core/`, `supabase/shared-src/` |
| Design tokens and shared controls | `constants/tokens.ts`, `components/ui/` |

## Screen views

Each screen loads one JSON view through `GET /views/<screen>`.
The Edge API forwards the user's bearer token to a member-scoped SQL view function, such as `view_home` or `view_roster`.
SQL checks membership and visibility.
The response is `{ ok, view }`.
Lists are bounded and use cursors; details and later pages load on request.
Authentication, league selection, and the change stream use separate reads.

## Cache and change hints

The client caches screen views by account, league, member, season, screen, and parameters.
Saved content renders first, then a background check validates it.
`league_versions` advances once per changed league transaction.
`league_changes` keeps recent change topics per league.
`GET /version?league=<uuid>&since=<decimal>` returns the counter and the changed topics.
The existing `league_change_hints` Realtime stream announces new versions.
An unchanged version needs no new view.
Changed topics invalidate only the affected views.
A missing range or mismatched response forces a full view.
Account changes clear private caches and reject late replies.
Hidden screens defer reads until they are visible again.

## Writes and offline replay

Every write runs on the server.
The client gives each logical write one request UUID and sends it as `x-request-id`.
Retries and offline replay keep the UUID and the original input.
`private.request_receipts` binds the result to the actor, function, and input hash.
A repeated request returns the saved result and repeats no effect.
Another actor or a changed payload cannot reuse a receipt.
The server rechecks membership, locks, ownership, and legality on every write.

The offline queue stores the account, league, input, and request ID, but no bearer token.
Reconnect replays actions in order under the matching account.
A failed action blocks later actions until the user retries.
PWA updates wait while unsent forms or queued actions hold the update guard.
Sign-out clears private caches, queued actions, and saved authentication.

## Live scores

A public Vercel route serves compact NBA game lines without user data or Supabase reads.
Visible live screens poll it about every 20 seconds.
The phone applies the shared scoring formula to its saved lineup and official score.
Postgres imports status changes, finals, corrections, and 30-minute checkpoints.
Public lines never authorize a write or establish a final result.
Old or missing snapshots show saved scores with a stale state.
[Operations](operations.md) covers rollback and hosted settings.

## Stored results and background refresh

`standings_current`, `matchup_totals`, `player_season_averages`, and `trade_value_cache` hold precomputed screen results.
A change marks the league season's refresh queue dirty.
The `refresh-views` worker recomputes and publishes the results.
Publication checks the claim token and input version, so an old worker cannot replace newer results.
Unchanged results skip the write and publish no new version.
Views expose a stale state while work is pending.

Trade estimates and matchup forecasts run in workers, not in screen loads.
An offer commits first; its estimate attaches later, and an estimate failure leaves the offer valid.
Forecast revision tokens reject old results.

## Statistics windows

Waivers offers Season, Past 7 days, and Past 15 days.
A window covers calendar dates in `America/New_York`, including today.
It is not the last N appearances.
Windows ignore the season selector and never fall back to another season.
A statistic with no recorded value stays null; it never takes the season average.

## Scheduled work

One SQL dispatcher owns the work queue and runs every minute.
It checks the operator pause before it enqueues or claims work.
Live work takes the first free worker slot.
Workers hold leases and heartbeat; a lost lease stops further writes.
Failed work backs off and becomes dead work after its last attempt.
`work_dashboard()` shows due, running, failed, and dead work.
`set_worker_paused(true, reason)` stops new scheduled work but does not cancel a running statement.
[Operations](operations.md) has the schedule, limits, and incident steps.

## Events and history

`league_events` stores product outcomes and terminal work outcomes.
Member-scoped readers hide failed claims, bids, and pending trade details from other members.
Durable league history is never deleted by retention.
`retention_dashboard()` reports cleanup rules, sizes, and errors.

## Public API and CLI

Every non-deleted league is public through `GET /public/v2/<resource>`.
The `pancake` CLI in `packages/pancake-cli` reads it and performs no writes.
[The agent guide](../public/agents.md) covers commands and schemas.

`supabase/functions/api/public/policy.json` declares every public field, source query, and record rule.
`tools/verify/public-policy.mjs` generates the response schemas and the SQL reader from that file.
Run `node tools/verify/public-policy.mjs --check` after any change to the policy.
The reader is a security definer function that only the Edge service role can call.
It applies record rules and the field projection before filters, sorting, and paging.

The privacy boundary excludes accounts, emails, invites, notifications, claims, bids, lineups, offers, votes, and estimates.
Only completed trades with a `completed_at` are public.
The projection never reads claims, bids, or lineups.
Manager budget, roster capacity, existing claims, and reservations never affect public free-agent fields.
The public API never reads the old share tokens or their rate counters.

Admission allows 60 reads per client IP per minute in a separate `public_admit_read` transaction.
The read transaction never updates rate counters or holds their row locks.
Only `CF-Connecting-IP` identifies the client.
A self-hosted deployment must overwrite this header at its trusted ingress before using this policy.
The CLI never returns stale cache data after an error.
