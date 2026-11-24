-- Canonical SQL source for private.lineup_game_started.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lineup_game_started(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM private.lineup_history_receipts r
    WHERE r.player_id = p_player_id AND r.game_date = p_game_date)
    OR private.player_game_started(p_player_id, p_game_date, now())
$$;
