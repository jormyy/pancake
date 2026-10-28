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

The matchup screen reads the forecast within its complete cached screen view.
Relevant league versions refresh that view while it is visible.
Hidden screens defer reads, and account changes reject late results.

The header separates earned points from projected final points.
Its compact summary shows projected totals and win odds.
The saved payload retains coverage, source details, and freshness.
Missing model inputs produce limited or unavailable odds.
The screen can show a score-share fallback when saved odds are absent.
That display fallback does not become a stored forecast.
Player rows separate projections from earned points.
The player profile uses the next-game projection pipeline without provider captions.

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

## Precomputed inputs

The worker prepares missing player-history and projection inputs before the context read.
Player history uses at most thirty completed played games before the requested date.
Preparation runs in bounded batches and preserves the original scoring calculation.
Stored season totals update projection inputs when player statistics change.
Date, scoring settings, player identity, and source revisions separate cached inputs.
Changed inputs invalidate the matching preparation state.
The context reader checks readiness and cannot publish an obsolete revision.

`test:db:matchup-forecast-history` checks the history bound and scoring parity.
`test:db:matchup-forecast-budget` measures prepared reads on populated local fixtures.
Preparation cost stays separate from warm context-read measurements.
