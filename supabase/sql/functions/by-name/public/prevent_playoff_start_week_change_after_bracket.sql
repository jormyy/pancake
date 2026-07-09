-- Canonical SQL source for public.prevent_playoff_start_week_change_after_bracket.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.prevent_playoff_start_week_change_after_bracket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM matchups AS matchup
    JOIN league_seasons AS season
      ON season.id = matchup.league_season_id
     AND season.is_current = true
   WHERE matchup.league_id = OLD.id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Playoff start week cannot be changed after current-season matchups have been generated.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
