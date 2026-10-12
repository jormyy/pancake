CREATE OR REPLACE FUNCTION private.invalidate_removed_game_stats()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_game_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.game_id = OLD.game_id AND NEW.player_id = OLD.player_id THEN
    RETURN NEW;
  END IF;
  FOR v_game_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[OLD.game_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.game_id END]) AS id
    WHERE id IS NOT NULL ORDER BY id
  LOOP
    UPDATE public.nba_games SET stats_synced_at = NULL
    WHERE id = v_game_id AND stats_synced_at IS NOT NULL;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
