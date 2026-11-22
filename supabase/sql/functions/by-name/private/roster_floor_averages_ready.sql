-- Canonical SQL source for private.roster_floor_averages_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_floor_averages_ready(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM private.screen_refresh_queue queued
      JOIN public.leagues league ON league.id = queued.league_id
     WHERE queued.league_id = p_league_id
       AND queued.league_season_id = p_league_season_id
       AND queued.averages_initialized
       AND queued.averages_scoring IS NOT DISTINCT FROM league.scoring_settings
  ) AND NOT EXISTS (
    SELECT 1
      FROM private.screen_average_dirty dirty
     WHERE dirty.league_season_id = p_league_season_id
  );
END;
$$;
