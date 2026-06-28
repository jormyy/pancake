-- Playoff bracket freeze hardening:
-- - Freeze playoff_start_week once playoff matchups exist for a league.

CREATE OR REPLACE FUNCTION public.prevent_playoff_start_week_change_after_bracket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM matchups AS matchup
   WHERE matchup.league_id = OLD.id
     AND matchup.matchup_type IN (
       'playoff_quarterfinal'::matchup_type,
       'playoff_semifinal'::matchup_type,
       'playoff_final'::matchup_type
     )
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Playoff start week cannot be changed after playoff matchups have been generated.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_playoff_start_week_change_after_bracket ON public.leagues;

CREATE TRIGGER prevent_playoff_start_week_change_after_bracket
  BEFORE UPDATE OF playoff_start_week ON public.leagues
  FOR EACH ROW
  WHEN (OLD.playoff_start_week IS DISTINCT FROM NEW.playoff_start_week)
  EXECUTE FUNCTION public.prevent_playoff_start_week_change_after_bracket();
