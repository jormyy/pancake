-- Canonical SQL source for private.lineup_history_locked.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lineup_history_locked(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_game_date < (now() AT TIME ZONE 'America/New_York')::date
    OR private.lineup_game_started(p_player_id, p_game_date)
$$;
