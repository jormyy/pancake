-- Canonical SQL source for private.draft_timer_opening_night_cutoff.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.draft_timer_opening_night_cutoff(p_season_year int)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (min(game_date)::timestamp + interval '9 hours') AT TIME ZONE 'America/New_York'
    FROM public.nba_games
   WHERE season_year = p_season_year
     AND nba_game_id ~ '^002[0-9]{7}$';
$$;
