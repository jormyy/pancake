-- Canonical SQL source for public.assert_current_season_for_uncleared_waiver_log.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.assert_current_season_for_uncleared_waiver_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = NEW.league_season_id
     AND season.league_id = NEW.league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waiver holds can only remain uncleared for the current league season.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
