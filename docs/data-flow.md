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
A forecast-only Home change reads just the selected forecast and keeps saved scores and lineups.
Pure score and game changes fetch their changing fields while preserving lineups and forecast values.
Mixed changes, missing versions, or mismatched responses require the full view.
Auth, membership, and change-stream requests are separate.
Account changes clear private caches and reject late replies.

## Live scores

The public Vercel route reads NBA or ESPN data without Supabase or user data.
Visible phones poll every 20 seconds while games are live.
The shared formula overlays live lines onto the authorized saved lineup and official score.
Past games and official finals use saved results.
Old or missing snapshots display saved scores with a stale state.
Postgres imports transitions, finals, corrections, and 30-minute checkpoints.
Official writes use the existing per-game ingestion and NBA final certification.
Normal live-only checkpoints create no screen version or broadcast; stale clients recover saved data directly.
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
Home filters changes by displayed teams and inputs.
Score corrections cover the full multi-week matchup; lineup changes stay scoped to the selected week and date.
Fresh public mode performs a ten-minute recovery check.
Stale and database modes reread saved screens every 20 seconds.
Missing version ranges require a fresh view; hidden screens defer reads.

Roster moves, lineup saves, trade acceptance, waivers, and draft actions execute on the server.
Request IDs make retries idempotent; actor, payload, ownership, locks, and permissions are checked again.
Realtime delivers committed action and official-score changes.
Public lines never authorize a write or establish a final result.
See [architecture](architecture.md) and [offline behavior](architecture.md#loading-and-offline-actions).

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
Use the [screen lab](verification.md#performance-evidence) for browser traffic and the [game-night lab](../scripts/bench/game-night/README.md) for memory pressure.

## Free-agent response compatibility

Migration `20261214002300_l5c_players_response.sql` omits unused ownership entries from free-agent responses.
It preserves the function signature and all other response fields.
Explicit support-player reads retain ownership entries.
Release 2.9.1 remains compatible with this response change; either side can ship first.
The current feature release still follows database, Edge, then frontend ordering.

## Statistics windows

Waivers offers Season, Past 7 days, and Past 15 days.
Season remains the default. Its existing automatic and explicit season choices stay unchanged.
Requests without a statistics window retain the original response shape, without window metadata.

## Dates and values

Both windows include the current NBA calendar date in America/New_York and the preceding N−1 dates.
The summary shows both dates, ET, per-game units, and “Includes today.”
These are calendar windows, not the last seven or fifteen appearances.
They ignore the season selector and never fall back to another season.

Waivers uses `player_window_averages` and `stats_window`.
The aggregation joins actual `player_game_stats` to the canonical `nba_games.game_date`.
It includes regular-season games and excludes DNP rows, preseason games, and dates outside the window.
Available current-day rows can change during a game.

Each box-score average uses the non-null values for that statistic.
Fantasy points use `v_fantasy_points`, including league weights, bonuses, and rounding each game before averaging.
No appearances means zero GP and blank averages. A recorded game can still have an unavailable statistic.
The new windows preserve that statistic as null instead of substituting a season average.

## Sorting and state

Players sorts the full filtered pool by the selected window before pagination.
All pages use the same selection. Switching windows rejects older requests.
Clear returns Players to its existing defaults.
The My Team screen and My Team search filter keep their season statistics.
Waivers refreshes its window identity at Eastern midnight and follow game-stat changes.

## Player read release order

Migration `20261130000100` replaces the dynasty reader without changing inputs, output columns, grants, or JSON values.
Database, then Edge, then merge the frontend.
