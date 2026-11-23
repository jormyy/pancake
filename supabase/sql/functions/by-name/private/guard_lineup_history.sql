-- Canonical SQL source for private.guard_lineup_history.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_lineup_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF current_setting('pancake.lineup_history_correction', true) = 'on'
    OR (TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.leagues WHERE id = OLD.league_id))
    OR (TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_id, OLD.league_season_id, OLD.player_id, OLD.game_date, OLD.slot_type)
      IS NOT DISTINCT FROM (NEW.member_id, NEW.league_id, NEW.league_season_id, NEW.player_id, NEW.game_date, NEW.slot_type))
    OR NOT private.lineup_history_locked(OLD.player_id, OLD.game_date) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'Lineup history is immutable: game_date is past or the game started; use private.correct_lineup_history()'
    USING ERRCODE = '55000',
      DETAIL = format('weekly_lineups %s: player %s on %s', OLD.id, OLD.player_id, OLD.game_date);
END;
$$;
