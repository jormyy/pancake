# Matchup forecasts

The header reads one shared forecast per matchup. It never computes odds during the screen load.

The background worker uses current earned points, saved lineups, and enabled automatic lineups. Automatic selection uses the existing position-constrained lineup optimizer. IR, taxi, and known unavailable players cannot enter automatic selections. Locked selections remain fixed.

Pregame points use `get_league_projection_rows`, the existing player projection pipeline. Sleeper/RotoWire takes priority. Supported FantasyPros data, internal projections, and season averages provide the existing fallbacks. The forecast requires the requested game date and a fresh source. Future source timestamps are rejected. Live games retain their cached pregame projection.

`independent-games-v1` adds expected remaining points to earned points. It estimates each player's variance from the last 30 completed, played games before today. At least five observations are required. Variances add across remaining player games. A normal distribution converts the difference into win odds. This assumes independent player games. It does not model teammate correlation or a full distribution of overtime outcomes.

Live expected points and variance scale with remaining regulation time. Overtime uses the remaining time in the current five-minute period. A missing live clock, projection, or scoring history produces limited or unavailable odds. Completed games never add projection points again. A completed tie reports a tie probability of one.

Roster, lineup, score, game, source, settings, and availability changes mark affected forecasts stale. A scheduled worker claims bounded batches. A three-minute lease prevents overlapping work. A newer input revision rejects an older result. Reads enforce league membership. Clients cannot publish forecasts or claim work.

Each result includes its model version, calculation time, input revision, coverage, and source details. Cached forecasts expire at the next known tipoff or after six hours. An expired result stays explicitly stale until recalculated.

Historical model validation and observed limits belong in the release evidence. Synthetic projections must remain labeled. Browser emulation does not establish physical-device performance.
