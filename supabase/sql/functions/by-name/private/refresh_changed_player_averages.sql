-- Canonical SQL source for private.refresh_changed_player_averages.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_changed_player_averages()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE private.screen_refresh_queue SET averages_initialized=false;
    RETURN NULL;
  END IF;
  IF TG_OP<>'DELETE' THEN
    INSERT INTO private.screen_average_dirty(league_season_id,player_id)
      SELECT season.id,NEW.player_id FROM public.league_seasons season WHERE season.season_year=NEW.season_year
      ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP<>'INSERT' THEN
    INSERT INTO private.screen_average_dirty(league_season_id,player_id)
      SELECT season.id,OLD.player_id FROM public.league_seasons season WHERE season.season_year=OLD.season_year
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
