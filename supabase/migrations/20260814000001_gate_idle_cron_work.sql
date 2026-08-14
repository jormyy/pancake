-- ============================================================
-- Gate idle cron work
--
-- 1. nba-live-poll ran every minute for 15h/day year-round; each tick took a
--    lease RPC pair, an edge cold start, and a CDN scoreboard fetch even with
--    zero non-final games (offseason: ~900 wasted invocations/day). Follow the
--    invoke_projection_sync_if_due() pattern: a SQL predicate that only invokes
--    the edge function when yesterday/today ET has a game that is not Final.
--    Gating on "not Final" (rather than "InProgress") still catches
--    Scheduled -> InProgress transitions.
--
-- 2. refresh-player-search-caches unconditionally rebuilt both analytics
--    matviews (~26s) daily even when player_game_stats had not changed for
--    months. Skip when no source rows are newer than the last successful
--    refresh, with a 7-day unconditional fallback so inputs that bypass the
--    watermark (e.g. league scoring settings) still converge weekly.
-- ============================================================

CREATE TABLE IF NOT EXISTS analytics.search_cache_refresh_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  refreshed_at timestamptz NOT NULL,
  source_watermark timestamptz
);

REVOKE ALL ON TABLE analytics.search_cache_refresh_state FROM PUBLIC;
REVOKE ALL ON TABLE analytics.search_cache_refresh_state FROM anon;
REVOKE ALL ON TABLE analytics.search_cache_refresh_state FROM authenticated;

CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', now()))::date;
BEGIN
  -- Mirrors livePollCandidateDates() in the edge function: yesterday + today
  -- ET, so late West-coast games that cross ET midnight stay covered.
  IF EXISTS (
    SELECT 1
      FROM public.nba_games
     WHERE game_date IN (v_today - 1, v_today)
       AND status <> 'Final'
  ) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_live_poll_if_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_live_poll_if_due() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_live_poll_if_due() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_live_poll_if_due() TO service_role;

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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'nba-live-poll',
      '* 15-23,0-5 * * *',
      $job$SELECT public.invoke_live_poll_if_due()$job$
    );
  END IF;
END $$;
