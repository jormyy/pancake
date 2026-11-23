-- Canonical SQL source for private.player_game_started.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.player_game_started(p_player_id uuid, p_game_date date, p_clock timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.player_slate_games(p_player_id, p_game_date) game
    WHERE game.status IN ('InProgress', 'Final')
       OR game.game_time <= p_clock
       OR game.started_at <= p_clock
  )
$$;
