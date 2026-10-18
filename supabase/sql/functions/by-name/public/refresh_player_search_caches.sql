-- Canonical SQL source for public.refresh_player_search_caches.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.refresh_player_search_caches()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, analytics
AS $$
DECLARE
  v_state analytics.search_cache_refresh_state;
  v_source_revision bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock(189736123, 2) THEN RETURN; END IF;
  SELECT revision INTO STRICT v_source_revision FROM analytics.search_cache_source_state WHERE id;
  SELECT * INTO v_state FROM analytics.search_cache_refresh_state WHERE id;

  IF v_state.refreshed_at IS NOT NULL
     AND v_state.refreshed_at > now() - interval '7 days'
     AND v_state.source_revision = v_source_revision THEN
    RETURN;
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_season_averages;
  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_avg_fantasy_points;
  DELETE FROM analytics.player_avg_fantasy_points_fresh fresh
  WHERE EXISTS (
    SELECT 1
    FROM analytics.mv_player_avg_fantasy_points cached
    WHERE cached.league_id = fresh.league_id
  );

  INSERT INTO analytics.search_cache_refresh_state (id, refreshed_at, source_revision)
  VALUES (true, now(), v_source_revision)
  ON CONFLICT (id) DO UPDATE
    SET refreshed_at = excluded.refreshed_at,
        source_revision = excluded.source_revision;
END;
$$;
