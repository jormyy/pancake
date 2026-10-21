-- Canonical SQL source for private.roster_status_game_started.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_status_game_started(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH slate AS (
    SELECT (now() AT TIME ZONE 'America/New_York')::date AS today
  )
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN nba_games AS g ON (
        ((g.home_team = p.nba_team OR g.away_team = p.nba_team)
          AND NOT EXISTS (
            SELECT 1 FROM player_game_stats AS observed
            JOIN nba_games AS actual ON actual.id = observed.game_id
            WHERE observed.player_id = p.id AND actual.game_date = g.game_date
          ))
        OR EXISTS (
          SELECT 1 FROM player_game_stats AS stats
          WHERE stats.player_id = p.id AND stats.game_id = g.id
        )
      )
      CROSS JOIN slate
     WHERE p.id = p_player_id
       AND g.game_date IN (slate.today - 1, slate.today)
       AND (
         g.status = 'InProgress'
         OR (g.game_date = slate.today AND g.status = 'Final')
         OR (g.game_time <= now() AND (g.game_date = slate.today OR g.game_time >= now() - interval '12 hours'))
         OR (g.started_at <= now() AND (g.game_date = slate.today OR g.started_at >= now() - interval '12 hours'))
       )
  )
$$;
