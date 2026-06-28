-- Playoff schedule and trade deadline hardening:
-- - Freeze playoff_start_week once the current-season schedule exists.
-- - Reject pending trade acceptance after the league trade deadline.

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

DROP TRIGGER IF EXISTS prevent_playoff_start_week_change_after_bracket ON public.leagues;

CREATE TRIGGER prevent_playoff_start_week_change_after_bracket
  BEFORE UPDATE OF playoff_start_week ON public.leagues
  FOR EACH ROW
  WHEN (OLD.playoff_start_week IS DISTINCT FROM NEW.playoff_start_week)
  EXECUTE FUNCTION public.prevent_playoff_start_week_change_after_bracket();

CREATE OR REPLACE FUNCTION public.prevent_trade_acceptance_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade_deadline date;
BEGIN
  SELECT league.trade_deadline
    INTO v_trade_deadline
    FROM leagues AS league
   WHERE league.id = NEW.league_id
   FOR UPDATE;

  IF v_trade_deadline IS NOT NULL
     AND v_trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Trade can no longer be accepted after the trade deadline.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_trade_acceptance_after_deadline ON public.trades;

CREATE TRIGGER prevent_trade_acceptance_after_deadline
  BEFORE UPDATE OF status ON public.trades
  FOR EACH ROW
  WHEN (OLD.status = 'pending'::trade_status AND NEW.status = 'accepted'::trade_status)
  EXECUTE FUNCTION public.prevent_trade_acceptance_after_deadline();
