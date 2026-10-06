-- Build one set of exact per-game averages for each distinct scoring configuration.
-- Reuse v_fantasy_points so rounding, bonuses and eligible games keep one owner.
-- Rename and replace within the migration transaction; preserve the public view's ACL.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

ALTER MATERIALIZED VIEW analytics.mv_player_avg_fantasy_points
  RENAME TO mv_player_avg_fantasy_points_previous;
ALTER INDEX analytics.idx_mv_player_avg_fantasy_points_unique
  RENAME TO idx_mv_player_avg_fantasy_points_unique_previous;
ALTER INDEX analytics.idx_mv_player_avg_fantasy_points_sort
  RENAME TO idx_mv_player_avg_fantasy_points_sort_previous;

CREATE MATERIALIZED VIEW analytics.mv_player_avg_fantasy_points AS
WITH league_groups AS MATERIALIZED (
  SELECT id AS league_id,
         first_value(id) OVER (PARTITION BY scoring_settings ORDER BY id) AS scoring_league_id
    FROM public.leagues
),
scored_averages AS MATERIALIZED (
  SELECT fp.league_id AS scoring_league_id,
         fp.player_id,
         fp.season_year,
         ROUND(AVG(fp.fantasy_points)::numeric, 2) AS avg_fantasy_points
    FROM public.v_fantasy_points fp
    JOIN (SELECT DISTINCT scoring_league_id FROM league_groups) representative
      ON representative.scoring_league_id = fp.league_id
    JOIN public.player_game_stats pgs
      ON pgs.id = fp.stat_id
     AND NOT pgs.did_not_play
   GROUP BY fp.league_id, fp.player_id, fp.season_year
)
SELECT league_groups.league_id,
       scored_averages.player_id,
       scored_averages.season_year,
       scored_averages.avg_fantasy_points
  FROM league_groups
  JOIN scored_averages USING (scoring_league_id);

CREATE UNIQUE INDEX idx_mv_player_avg_fantasy_points_unique
  ON analytics.mv_player_avg_fantasy_points(league_id, player_id, season_year);
CREATE INDEX idx_mv_player_avg_fantasy_points_sort
  ON analytics.mv_player_avg_fantasy_points(league_id, season_year, avg_fantasy_points DESC NULLS LAST, player_id);
GRANT SELECT ON analytics.mv_player_avg_fantasy_points TO authenticated, anon, service_role;

CREATE OR REPLACE VIEW public.v_player_avg_fantasy_points
  WITH (security_invoker = true)
AS
SELECT fp.league_id, fp.player_id, fp.season_year, fp.avg_fantasy_points
FROM analytics.mv_player_avg_fantasy_points fp
JOIN public.leagues l ON l.id = fp.league_id
UNION ALL
SELECT fresh.league_id, fresh.player_id, fresh.season_year, fresh.avg_fantasy_points
FROM analytics.player_avg_fantasy_points_fresh fresh
JOIN public.leagues l ON l.id = fresh.league_id
WHERE NOT EXISTS (
  SELECT 1 FROM analytics.mv_player_avg_fantasy_points cached
  WHERE cached.league_id = fresh.league_id
);

DROP MATERIALIZED VIEW analytics.mv_player_avg_fantasy_points_previous;
ANALYZE analytics.mv_player_avg_fantasy_points;
