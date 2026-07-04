-- seed_league_fantasy_avgs aggregated v_fantasy_points across EVERY season on
-- every league INSERT (inside create_league's transaction), an unbounded scan
-- that grows with stats volume and taxes every test/e2e league. search_players
-- only ever reads the current season's average (p_season_year defaults to
-- current_season_year_et()), so seed only that season. This bounds create-league
-- latency and stops storing dead historical-season rows in the fresh table.

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
    AND fp.season_year = public.current_season_year_et()
  GROUP BY fp.league_id, fp.player_id, fp.season_year
  ON CONFLICT (league_id, player_id, season_year) DO UPDATE
    SET avg_fantasy_points = EXCLUDED.avg_fantasy_points;
$$;

REVOKE ALL ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) FROM anon;
REVOKE ALL ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION analytics.seed_league_fantasy_avgs(uuid) TO service_role;

-- Drop the dead non-current-season rows the previous definition stored.
DELETE FROM analytics.player_avg_fantasy_points_fresh
WHERE season_year <> public.current_season_year_et();
