-- Canonical SQL source for private.roster_status_game_started.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_status_game_started(p_player_id uuid, p_clock timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH slate AS (
    SELECT (p_clock AT TIME ZONE 'America/New_York')::date AS today
  )
  SELECT private.player_game_started(p_player_id, slate.today, p_clock) OR EXISTS (
    SELECT 1 FROM private.player_slate_games(p_player_id, slate.today - 1) game
    WHERE game.status = 'InProgress'
       OR game.game_time BETWEEN p_clock - interval '12 hours' AND p_clock
       OR game.started_at BETWEEN p_clock - interval '12 hours' AND p_clock
  )
  FROM slate
$$;
