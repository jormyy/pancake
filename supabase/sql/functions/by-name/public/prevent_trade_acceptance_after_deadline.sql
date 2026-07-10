-- Canonical SQL source for public.prevent_trade_acceptance_after_deadline.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.prevent_trade_acceptance_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade_deadline date;
  v_league_status league_status;
  v_champion_finalized boolean := false;
BEGIN
  SELECT league.trade_deadline, league.status
    INTO v_trade_deadline, v_league_status
    FROM leagues AS league
   WHERE league.id = NEW.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
     WHERE matchup.league_id = NEW.league_id
       AND matchup.league_season_id = NEW.league_season_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_trade_deadline IS NOT NULL
     AND v_trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league_status = 'active'::league_status
       OR (v_league_status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
