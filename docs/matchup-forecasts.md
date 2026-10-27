# Matchup forecasts

The header reads one shared forecast per matchup. It never computes odds during the screen load.

The background worker uses current earned points, saved lineups, and enabled automatic lineups. Automatic selection uses the existing position-constrained lineup optimizer. IR, taxi, and known unavailable players cannot enter automatic selections. Locked selections remain fixed.

Pregame points use `get_league_projection_rows`, the existing player projection pipeline. Sleeper/RotoWire takes priority. Supported FantasyPros data, internal projections, and season averages provide the existing fallbacks. The forecast requires the requested game date and a fresh source. Future source timestamps are rejected. Live games retain their cached pregame projection.

`independent-games-v1` adds expected remaining points to earned points. It estimates each player's variance from the last 30 completed, played games before today. At least five observations are required. Variances add across remaining player games. A normal distribution converts the difference into win odds. This assumes independent player games. It does not model teammate correlation or a full distribution of overtime outcomes.

Live expected points and variance scale with remaining regulation time. Overtime uses the remaining time in the current five-minute period. A missing live clock, projection, or scoring history produces limited or unavailable odds. Completed games never add projection points again. A completed tie reports a tie probability of one.

Roster, lineup, score, game, source, settings, and availability changes mark affected forecasts stale. A scheduled worker claims bounded batches. A three-minute lease prevents overlapping work. A newer input revision rejects an older result. Reads enforce league membership. Clients cannot publish forecasts or claim work.

Each result includes its model version, calculation time, input revision, coverage, and source details. Cached forecasts expire at the next known tipoff or after six hours. An expired result stays explicitly stale until recalculated.

The release deploys the database before the `matchup-forecast` Edge worker and the frontend.
See the [release order](../supabase/RELEASE-DB.md#release-order-for-this-release).

Historical model validation and observed limits belong in the release evidence. Synthetic projections must remain labeled. Browser emulation does not establish physical-device performance.

The matchup screen retains a user-scoped cache. It reads the cached RPC when visible, on reconnect, and after relevant league changes. Public completion events are filtered to the current league and matchup. Hidden screens release their subscription. Account changes reject late results.

The header separates earned points from projected final points. It shows win odds, coverage, calculation time, sources, and limited or stale status. Missing inputs never become zero points or 50% odds. Player rows show a projection separately from earned points; their accessible label includes source and source time. The player profile uses the existing next-game projection pipeline and shows its source and freshness.

## Concurrent publication

Completion locks the league and matchup with `FOR KEY SHARE` before it locks the forecast queue.
Scoring locks these parents before queue invalidation.
The common order prevents a cache insert from holding the queue while its foreign keys wait for scoring.
Shared parent locks still permit concurrent forecast completions.

Revision and claim-token checks run after these locks. A score change after publication marks that result stale. A worker with older inputs cannot clear the new work.

Run the focused database regression on an isolated local database:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/matchup-forecast-cache.sql
node supabase/tests/db/matchup-forecast-concurrency.mjs
```

Supply `SUPABASE_DB_URL` and `PANCAKE_TEST_DB_PORT` from the isolated local stack.
The cache check covers membership, invalidation, claim tokens, expiry, and rejected stale publication. The check creates and deletes its own fixtures. It observes concurrent scoring and parallel completion. It checks stale results, expired tokens, retries, and account access. It also detects a deliberately corrupted cache revision.
