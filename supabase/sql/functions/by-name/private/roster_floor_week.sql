-- Canonical SQL source for private.roster_floor_week.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_floor_week(p_league_id uuid, p_league_season_id uuid)
RETURNS TABLE (week_number int, week_end date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT weeks.week_number, weeks.week_end
    FROM public.league_seasons season
    JOIN public.leagues league ON league.id = season.league_id
    JOIN public.season_weeks weeks ON weeks.season_year = season.season_year
   WHERE season.id = p_league_season_id
     AND season.league_id = p_league_id
     AND season.is_current
     AND weeks.week_end <= (now() AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date
     AND EXISTS (
       SELECT 1
         FROM public.matchups matchup
        WHERE matchup.league_id = p_league_id
          AND matchup.league_season_id = p_league_season_id
          AND matchup.week_number = weeks.week_number
     )
   ORDER BY weeks.week_end DESC, weeks.week_number DESC
   LIMIT 1
$$;
