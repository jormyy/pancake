-- Canonical SQL source for analytics.seed_league_fantasy_avgs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
