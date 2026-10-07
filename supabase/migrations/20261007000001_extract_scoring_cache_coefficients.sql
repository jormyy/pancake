-- Extract JSON coefficient text once per league before the hot scoring aggregate.
-- Keep numeric casts inside the original formula: unused invalid bonuses still short-circuit.
-- tests/db/player-search-cache-refresh.sql compares this expression with v_fantasy_points.
-- Shared settings still score one representative; settings equality remains JSONB equality.
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
WITH coefficients AS MATERIALIZED (
  SELECT id,
         scoring_settings->>'points' AS points,
         scoring_settings->>'rebounds' AS rebounds,
         scoring_settings->>'assists' AS assists,
         scoring_settings->>'steals' AS steals,
         scoring_settings->>'blocks' AS blocks,
         scoring_settings->>'turnovers' AS turnovers,
         scoring_settings->>'three_pointers_made' AS three_pointers_made,
         scoring_settings->>'field_goals_made' AS field_goals_made,
         scoring_settings->>'field_goals_attempted' AS field_goals_attempted,
         scoring_settings->>'free_throws_made' AS free_throws_made,
         scoring_settings->>'free_throws_attempted' AS free_throws_attempted,
         scoring_settings->>'double_double' AS double_double,
         scoring_settings->>'triple_double' AS triple_double
  FROM public.leagues
),
league_groups AS MATERIALIZED (
  SELECT id AS league_id,
         first_value(id) OVER (PARTITION BY scoring_settings ORDER BY id) AS scoring_league_id
    FROM public.leagues
),
scored_averages AS MATERIALIZED (
  SELECT fp.league_id AS scoring_league_id,
         fp.player_id,
         fp.season_year,
         ROUND(AVG(fp.fantasy_points)::numeric, 2) AS avg_fantasy_points
    FROM (
SELECT
  pgs.id AS stat_id,
  l.id             AS league_id,
  pgs.player_id,
  pgs.game_id,
  pgs.season_year,
  pgs.week_number,
  CASE WHEN pgs.did_not_play THEN 0::numeric ELSE ROUND((
    COALESCE(pgs.points                * l.points::numeric,                0) +
    COALESCE(pgs.rebounds              * l.rebounds::numeric,              0) +
    COALESCE(pgs.assists               * l.assists::numeric,               0) +
    COALESCE(pgs.steals                * l.steals::numeric,                0) +
    COALESCE(pgs.blocks                * l.blocks::numeric,                0) +
    COALESCE(pgs.turnovers             * l.turnovers::numeric,             0) +
    COALESCE(pgs.three_pointers_made   * l.three_pointers_made::numeric,   0) +
    COALESCE(pgs.field_goals_made      * l.field_goals_made::numeric,      0) +
    COALESCE(pgs.field_goals_attempted * l.field_goals_attempted::numeric, 0) +
    COALESCE(pgs.free_throws_made      * l.free_throws_made::numeric,      0) +
    COALESCE(pgs.free_throws_attempted * l.free_throws_attempted::numeric, 0) +
    CASE WHEN pgs.double_double = true
      THEN COALESCE(l.double_double::numeric, 0) ELSE 0 END +
    CASE WHEN pgs.triple_double = true
      THEN COALESCE(l.triple_double::numeric, 0) ELSE 0 END
  ), 2) END AS fantasy_points
FROM player_game_stats pgs
INNER JOIN nba_games g
  ON g.id = pgs.game_id
  AND public.is_regular_season_game_id(g.nba_game_id)
CROSS JOIN coefficients l
    ) fp
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
