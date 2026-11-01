# Data flow

## Screen reads

Private screens read a member-scoped JSON view through the Edge API.
The API forwards the bearer token; SQL checks membership and visibility.
Home uses compact lineup and scoring tuples when requested by the current client.
Other clients retain the full response shape.
Responses use gzip when the client accepts it.
Maps and sets are restored after transport.

A screen cache holds at most 48 entries and 4 MiB of JSON.
Its key includes account, league, member, season, screen, and normalized parameters.
Saved content renders before background validation.
A cold screen reads one view; an unchanged version needs no additional view.
Auth, membership, and change-stream requests are separate.
Account changes clear private caches and reject late replies.

## Live scores

The public Vercel route reads NBA or ESPN data without Supabase or user data.
Visible phones poll every 30 seconds while games are live.
The shared formula overlays live lines onto the authorized saved lineup and official score.
Past games and official finals use saved results.
Old or missing snapshots display saved scores with a stale state.
Postgres imports transitions, finals, corrections, and 30-minute checkpoints.
Normal checkpoint versions do not send live-only broadcasts.
See [live scores](live-scores.md) for rollback, cache rules, settings, and lab measurements.

## Screen refresh

Screen publication updates relevant matchup totals and player averages on the approved schedule.
Standings refresh when a weekly matchup ends, and for required initialization or setup changes.
Game finals and corrections maintain season totals.
Trade estimates at creation remain separate from nightly re-analysis.
Publication checks its claim and input version; an old worker cannot replace newer results.
Content comparisons skip unchanged cache rows.
Refresh timestamps alone create no league version.
See [scheduler operations](operations-scheduler.md).

Database, then Edge, then merge the frontend.
Migration `20261211000100` and the refresh worker form a historical release unit.
Release 2.7.2 applies `20261211000100`, `20261211000200`, `20261211000300`, and `20261211000400` in that order.
Current deployment requirements are in the [release guide](../supabase/RELEASE-DB.md#release-order-for-this-release).

## Changes and actions

One changed league transaction advances one version and batches its relevant hints.
Home filters changes by displayed teams, date, and inputs.
Fresh public mode performs a ten-minute recovery check.
Stale and database modes retain the 20-second recovery check.
Missing version ranges require a fresh view; hidden screens defer reads.

Roster moves, lineup saves, trade acceptance, waivers, and draft actions execute on the server.
Request IDs make retries idempotent; actor, payload, ownership, locks, and permissions are checked again.
Realtime delivers committed action and official-score changes.
Public lines never authorize a write or establish a final result.
See [architecture](architecture.md) and [offline behavior](pwa-live-data.md).

## Stored statistics

`player_game_stats` is a regular table with player, date, season, and game indexes.
Game-day reads filter by date and requested players.
The identity guard, replica identity, score revisions, and final certification remain active.
No exact duplicate player-stat index is removed.
The duplicate `nba_games(game_time)` index is removed after definition equality checks.
Statistics have no automatic historical retention.
The [IO model](io-audit.md) separates reads, writes, WAL, and memory pressure.

## Measurement output

Performance captures and generated rankings belong in an external evidence directory.
They are not the application contract and do not replace this document.
Use the [screen lab](perf-lab.md) for browser traffic and the [game-night lab](../scripts/bench/game-night/README.md) for memory pressure.

## Free-agent response compatibility

Migration `20261214002300_l5c_players_response.sql` omits unused ownership entries from free-agent responses.
It preserves the function signature and all other response fields.
Explicit support-player reads retain ownership entries.
Release 2.9.1 remains compatible with this response change; either side can ship first.
The current feature release still follows database, Edge, then frontend ordering.
