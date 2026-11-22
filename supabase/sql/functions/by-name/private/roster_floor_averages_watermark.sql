-- Canonical SQL source for private.roster_floor_averages_watermark.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_floor_averages_watermark(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::text || ':' || COALESCE(max(cached.refreshed_at)::text, '') || ':' || COALESCE(max(cached.version)::text, '')
    FROM public.player_season_averages cached
   WHERE cached.league_id = p_league_id
     AND cached.league_season_id = p_league_season_id
$$;
