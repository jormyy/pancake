-- Canonical SQL source for private.assert_schedule_not_started.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_schedule_not_started(p_season_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.matchups AS matchup
     JOIN public.league_seasons AS season ON season.id = matchup.league_season_id
     LEFT JOIN public.season_weeks AS week ON week.season_year = season.season_year AND week.week_number = matchup.week_number
    WHERE matchup.league_season_id = p_season_id
      AND (matchup.is_finalized OR matchup.winner_member_id IS NOT NULL
           OR COALESCE(matchup.home_points, 0) <> 0 OR COALESCE(matchup.away_points, 0) <> 0
           OR week.id IS NULL OR week.week_start <= (now() AT TIME ZONE 'America/New_York')::date)
  ) THEN
    RAISE EXCEPTION 'The current schedule has started or its dates are unavailable. Playoff settings and existing matchups cannot change.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
