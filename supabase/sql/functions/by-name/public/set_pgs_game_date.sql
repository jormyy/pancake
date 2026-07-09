-- Canonical SQL source for public.set_pgs_game_date.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION set_pgs_game_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  SELECT game_date INTO NEW.game_date FROM nba_games WHERE id = NEW.game_id;
  RETURN NEW;
END;
$$;
