-- Canonical SQL source for private.roll_setup_league_seasons.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roll_setup_league_seasons(p_now timestamptz DEFAULT now())
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_year int := private.setup_season_year_et(p_now);
  v_season record;
  v_shift int;
  v_rolled int := 0;
BEGIN
  -- A league still in setup has not drafted or played. If its season is
  -- already over, move it to the season it will actually play, in place, so
  -- members, waiver spots, and FAAB balances stay attached.
  FOR v_season IN
    SELECT season.id, season.league_id, season.season_year
      FROM public.league_seasons AS season
      JOIN public.leagues AS league
        ON league.id = season.league_id
     WHERE season.is_current
       AND season.season_year < v_target_year
       AND league.status = 'setup'::public.league_status
       AND league.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.roster_players AS roster WHERE roster.league_season_id = season.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.matchups AS matchup WHERE matchup.league_season_id = season.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.league_seasons AS later
          WHERE later.league_id = season.league_id
            AND later.season_year >= v_target_year
       )
     ORDER BY season.league_id
     FOR UPDATE OF season, league
  LOOP
    v_shift := v_target_year - v_season.season_year;

    UPDATE public.league_seasons
       SET season_year = v_target_year
     WHERE id = v_season.id;

    -- Future picks move with the season. Two passes keep the
    -- (league, year, round, owner) key unique while rows shift.
    UPDATE public.draft_picks
       SET season_year = season_year + v_shift + 10000
     WHERE league_id = v_season.league_id;
    UPDATE public.draft_picks
       SET season_year = season_year - 10000
     WHERE league_id = v_season.league_id;

    UPDATE public.leagues
       SET trade_deadline = private.trade_deadline_for_season(trade_deadline, v_target_year)
     WHERE id = v_season.league_id;

    v_rolled := v_rolled + 1;
  END LOOP;

  RETURN v_rolled;
END;
$$;
