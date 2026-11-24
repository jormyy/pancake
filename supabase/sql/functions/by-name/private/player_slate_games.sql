-- Canonical SQL source for private.player_slate_games.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.player_slate_games(p_player_id uuid, p_game_date date)
RETURNS SETOF public.nba_games
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH day_games AS MATERIALIZED (
    SELECT * FROM nba_games WHERE game_date = p_game_date
  ), participation AS (
    SELECT game.id
    FROM day_games game
    WHERE EXISTS (
      SELECT 1 FROM player_game_stats stats
      WHERE stats.player_id = p_player_id AND stats.game_id = game.id
    ) OR EXISTS (
      SELECT 1 FROM private.player_game_memberships membership
      WHERE membership.player_id = p_player_id AND membership.game_id = game.id
    )
  )
  SELECT game.* FROM day_games game
  WHERE game.id IN (SELECT id FROM participation)
  UNION ALL
  SELECT game.* FROM day_games game
  JOIN players player ON player.id = p_player_id
  WHERE (game.home_team = player.nba_team OR game.away_team = player.nba_team)
    AND NOT EXISTS (SELECT 1 FROM participation)
$$;
