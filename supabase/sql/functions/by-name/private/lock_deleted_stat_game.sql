-- Canonical SQL source for private.lock_deleted_stat_game.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lock_deleted_stat_game()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.nba_games WHERE id=OLD.game_id FOR SHARE;
  RETURN OLD;
END;
$$;
