-- Canonical SQL source for private.history_capture_lineup.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.history_capture_lineup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'players' THEN
    INSERT INTO private.lineup_history_receipts(lineup_id,player_id,game_date,row_data)
    SELECT w.id,w.player_id,w.game_date,to_jsonb(w)
    FROM public.weekly_lineups w
    WHERE w.player_id=OLD.id
      AND (w.game_date < (now() AT TIME ZONE 'America/New_York')::date
        OR private.lineup_game_started(w.player_id,w.game_date))
    ON CONFLICT(lineup_id) DO NOTHING;
    RETURN NEW;
  END IF;
  IF OLD.game_date < (now() AT TIME ZONE 'America/New_York')::date
    OR private.lineup_game_started(OLD.player_id,OLD.game_date) THEN
    INSERT INTO private.lineup_history_receipts(lineup_id,player_id,game_date,row_data)
    VALUES(OLD.id,OLD.player_id,OLD.game_date,to_jsonb(OLD))
    ON CONFLICT(lineup_id) DO NOTHING;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
