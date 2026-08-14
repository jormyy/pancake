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
  v_source_watermark timestamptz;
BEGIN
  SELECT max(greatest(created_at, updated_at))
    INTO v_source_watermark
    FROM public.player_game_stats;

  SELECT * INTO v_state FROM analytics.search_cache_refresh_state WHERE id;

  -- Skip the ~26s double matview rebuild when nothing changed since the last
  -- refresh. The 7-day fallback re-syncs inputs the watermark cannot see
  -- (league scoring settings feeding mv_player_avg_fantasy_points).
  IF v_state.refreshed_at IS NOT NULL
     AND v_state.refreshed_at > now() - interval '7 days'
     AND (v_source_watermark IS NULL OR v_source_watermark <= coalesce(v_state.source_watermark, '-infinity'::timestamptz)) THEN
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

  INSERT INTO analytics.search_cache_refresh_state (id, refreshed_at, source_watermark)
  VALUES (true, now(), v_source_watermark)
  ON CONFLICT (id) DO UPDATE
    SET refreshed_at = excluded.refreshed_at,
        source_watermark = excluded.source_watermark;
END;
$$;
