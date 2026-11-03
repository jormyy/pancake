# Actual statistics windows

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

## Verification

Run the SQL check only against an isolated local database:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-stats-windows.sql
npx vitest run tests/hooks/player-search-stats-window.test.ts tests/lib/stats-window.test.ts
```

The SQL fixtures test inclusive boundaries, future dates, DNP, game type, nulls, scoring, pagination, sorting, and the current partial day.
Fixtures do not establish upstream data availability.
The task evidence records a separate production read and arithmetic comparison using actual records.

The database migration must precede the frontend release. This task does not deploy either change.
