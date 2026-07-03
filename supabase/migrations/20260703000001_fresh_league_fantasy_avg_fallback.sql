-- v_player_avg_fantasy_points is backed by analytics.mv_player_avg_fantasy_points,
-- which refreshes on a daily cron. A league created after the last refresh has no
-- rows in the cache, so every fantasy-average read (roster FP column, search_players
-- fpts sort) is NULL until the next refresh — up to 24h of missing scores for brand
-- new leagues.
--
-- Fix: serve cached rows for leagues present in the materialized view, and compute
-- live (the pre-cache query shape) only for leagues the cache has not seen yet. The
-- NOT EXISTS probe filters the leagues relation before any aggregation work, so
-- cached leagues keep the indexed hot path.

CREATE OR REPLACE VIEW public.v_player_avg_fantasy_points
  WITH (security_invoker = true)
AS
SELECT
  fp.league_id,
  fp.player_id,
  fp.season_year,
  fp.avg_fantasy_points
FROM analytics.mv_player_avg_fantasy_points fp
JOIN public.leagues l
  ON l.id = fp.league_id
UNION ALL
SELECT
  fp.league_id,
  fp.player_id,
  fp.season_year,
  ROUND(AVG(fp.fantasy_points)::numeric, 2) AS avg_fantasy_points
FROM public.v_fantasy_points fp
JOIN public.player_game_stats pgs
  ON pgs.id = fp.stat_id
 AND NOT pgs.did_not_play
WHERE NOT EXISTS (
  SELECT 1
  FROM analytics.mv_player_avg_fantasy_points cached
  WHERE cached.league_id = fp.league_id
)
GROUP BY fp.league_id, fp.player_id, fp.season_year;

GRANT SELECT ON public.v_player_avg_fantasy_points TO authenticated, anon, service_role;
