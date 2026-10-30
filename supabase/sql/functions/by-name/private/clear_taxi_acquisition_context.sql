-- Canonical SQL source for private.clear_taxi_acquisition_context.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.clear_taxi_acquisition_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  DELETE FROM private.taxi_acquisition_context WHERE transaction_id=pg_current_xact_id()
    AND league_id=NEW.league_id AND league_season_id=NEW.league_season_id
    AND member_id=NEW.member_id AND player_id=NEW.player_id;
  RETURN NEW;
END;
$$;
