-- 20260703000001 served uncached leagues by computing fantasy averages live
-- inside v_player_avg_fantasy_points. That aggregation is fine standalone
-- (~0.6s) but blows past the statement timeout when the planner nests it in
-- search_players' per-player joins. Replace the live branch with a small
-- indexed side table that is seeded once per league at creation time and
-- pruned after every materialized-view refresh, so both cached and fresh
-- leagues stay on plain indexed reads.

CREATE TABLE IF NOT EXISTS analytics.player_avg_fantasy_points_fresh (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  player_id uuid NOT NULL,
  season_year int NOT NULL,
  avg_fantasy_points numeric NOT NULL,
  PRIMARY KEY (league_id, player_id, season_year)
);

GRANT SELECT ON analytics.player_avg_fantasy_points_fresh TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION analytics.seed_league_fantasy_avgs(p_league_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, analytics
AS $$
  INSERT INTO analytics.player_avg_fantasy_points_fresh
    (league_id, player_id, season_year, avg_fantasy_points)
  SELECT
    fp.league_id,
    fp.player_id,
    fp.season_year,
    ROUND(AVG(fp.fantasy_points)::numeric, 2)
  FROM public.v_fantasy_points fp
  JOIN public.player_game_stats pgs
    ON pgs.id = fp.stat_id
   AND NOT pgs.did_not_play
  WHERE fp.league_id = p_league_id
  GROUP BY fp.league_id, fp.player_id, fp.season_year
  ON CONFLICT (league_id, player_id, season_year) DO UPDATE
    SET avg_fantasy_points = EXCLUDED.avg_fantasy_points;
$$;

REVOKE ALL ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) FROM anon;
REVOKE ALL ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) TO service_role;

-- Every league-creation path (create_league RPC, service tooling, fixtures)
-- gets averages immediately.
CREATE OR REPLACE FUNCTION public.leagues_seed_fantasy_avgs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, analytics
AS $$
BEGIN
  PERFORM analytics.seed_league_fantasy_avgs(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leagues_seed_fantasy_avgs ON public.leagues;
CREATE TRIGGER leagues_seed_fantasy_avgs
AFTER INSERT ON public.leagues
FOR EACH ROW EXECUTE FUNCTION public.leagues_seed_fantasy_avgs();

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
  fresh.league_id,
  fresh.player_id,
  fresh.season_year,
  fresh.avg_fantasy_points
FROM analytics.player_avg_fantasy_points_fresh fresh
JOIN public.leagues l
  ON l.id = fresh.league_id
WHERE NOT EXISTS (
  SELECT 1
  FROM analytics.mv_player_avg_fantasy_points cached
  WHERE cached.league_id = fresh.league_id
);

GRANT SELECT ON public.v_player_avg_fantasy_points TO authenticated, anon, service_role;

-- Once the nightly refresh folds a league into the materialized view, its
-- fresh rows are redundant — prune them so the side table stays small.
CREATE OR REPLACE FUNCTION public.refresh_player_search_caches()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, analytics
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_season_averages;
  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_avg_fantasy_points;
  DELETE FROM analytics.player_avg_fantasy_points_fresh fresh
  WHERE EXISTS (
    SELECT 1
    FROM analytics.mv_player_avg_fantasy_points cached
    WHERE cached.league_id = fresh.league_id
  );
END;
$$;

-- Backfill: seed every league the materialized view has not covered yet.
DO $$
DECLARE
  league_record record;
BEGIN
  FOR league_record IN
    SELECT l.id
    FROM public.leagues l
    WHERE NOT EXISTS (
      SELECT 1
      FROM analytics.mv_player_avg_fantasy_points cached
      WHERE cached.league_id = l.id
    )
  LOOP
    PERFORM analytics.seed_league_fantasy_avgs(league_record.id);
  END LOOP;
END;
$$;
