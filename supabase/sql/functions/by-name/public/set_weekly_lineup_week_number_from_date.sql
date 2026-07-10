-- Canonical SQL source for public.set_weekly_lineup_week_number_from_date.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.set_weekly_lineup_week_number_from_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_week_number int;
BEGIN
  SELECT sw.week_number
    INTO v_week_number
    FROM league_seasons ls
    JOIN season_weeks sw ON sw.season_year = ls.season_year
   WHERE ls.id = NEW.league_season_id
     AND ls.league_id = NEW.league_id
     AND NEW.game_date BETWEEN sw.week_start AND sw.week_end
   LIMIT 1;

  IF v_week_number IS NULL THEN
    RAISE EXCEPTION 'No season week found for lineup date %.', NEW.game_date
      USING ERRCODE = 'P0001';
  END IF;

  NEW.week_number := v_week_number;
  RETURN NEW;
END;
$$;
