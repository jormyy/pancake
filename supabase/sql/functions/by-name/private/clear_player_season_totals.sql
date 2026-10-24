-- Canonical SQL source for private.clear_player_season_totals.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.clear_player_season_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  TRUNCATE analytics.player_season_totals;
  PERFORM private.emit_player_stats_hint(ARRAY(SELECT DISTINCT season_year FROM public.league_seasons WHERE is_current));
  RETURN NULL;
END;
$$;
