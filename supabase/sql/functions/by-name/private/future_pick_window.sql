-- Canonical SQL source for private.future_pick_window.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.future_pick_window(p_league_id uuid, OUT first_draft_year int, OUT last_draft_year int)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    CASE WHEN EXISTS (
      SELECT 1 FROM public.league_seasons earlier
      WHERE earlier.league_id=season.league_id AND earlier.season_year<season.season_year
    ) THEN private.draft_year_for_season(season.season_year) ELSE season.season_year END,
    season.season_year+league.future_pick_years-1
  FROM public.leagues league
  JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
  WHERE league.id=p_league_id
$$;
