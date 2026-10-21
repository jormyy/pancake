-- Canonical SQL source for private.lineup_game_started.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lineup_game_started(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- A lineup slot locks once the player's game that day has started: the feed
  -- says so, its scheduled tip-off has passed, or a start time is recorded.
  WITH participation AS (
    SELECT game_id FROM player_game_stats WHERE player_id = p_player_id
    UNION
    SELECT game_id FROM private.player_game_memberships WHERE player_id = p_player_id
  )
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN nba_games AS g
        ON g.game_date = p_game_date
       AND (
         ((g.home_team = p.nba_team OR g.away_team = p.nba_team)
           AND NOT EXISTS (
             SELECT 1 FROM participation AS observed
             JOIN nba_games AS actual ON actual.id = observed.game_id
             WHERE actual.game_date = p_game_date
           ))
         OR EXISTS (
           SELECT 1 FROM participation AS stats
            WHERE stats.game_id = g.id
         )
       )
     WHERE p.id = p_player_id
       AND (
         g.status IN ('InProgress', 'Final')
         OR (g.game_time IS NOT NULL AND g.game_time <= now())
         OR (g.started_at IS NOT NULL AND g.started_at <= now())
       )
  )
$$;
