-- Only regular-season NBA games should contribute to fantasy scoring,
-- projections, or player averages. NBA CDN/API IDs use a 00x prefix:
--   001 preseason, 002 regular season, 003 All-Star, 004 playoffs.
-- Historical Basketball Reference rows use date/team IDs, so they remain
-- countable regular-season history.

CREATE OR REPLACE FUNCTION public.is_regular_season_game_id(p_game_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_game_id IS NULL OR btrim(p_game_id) = '' THEN false
    WHEN btrim(p_game_id) LIKE '002%' THEN true
    WHEN btrim(p_game_id) ~ '^00[0-9]' THEN false
    ELSE true
  END
$$;

DELETE FROM public.player_game_stats pgs
USING public.nba_games g
WHERE pgs.game_id = g.id
  AND g.nba_game_id ~ '^00[0-9]'
  AND NOT public.is_regular_season_game_id(g.nba_game_id);

DELETE FROM public.nba_games g
WHERE g.nba_game_id ~ '^00[0-9]'
  AND NOT public.is_regular_season_game_id(g.nba_game_id);

DELETE FROM public.player_projections pp
WHERE NOT EXISTS (
  SELECT 1
  FROM public.nba_games g
  WHERE g.season_year = pp.season_year
    AND g.week_number = pp.week_number
    AND public.is_regular_season_game_id(g.nba_game_id)
);

DELETE FROM public.season_weeks sw
WHERE NOT EXISTS (
  SELECT 1
  FROM public.nba_games g
  WHERE g.season_year = sw.season_year
    AND g.week_number = sw.week_number
    AND public.is_regular_season_game_id(g.nba_game_id)
);

CREATE INDEX IF NOT EXISTS idx_nba_games_regular_season_week
  ON public.nba_games(season_year, week_number)
  WHERE public.is_regular_season_game_id(nba_game_id);

CREATE INDEX IF NOT EXISTS idx_nba_games_regular_game_date
  ON public.nba_games(game_date)
  WHERE public.is_regular_season_game_id(nba_game_id);

CREATE OR REPLACE FUNCTION compute_fantasy_points(
  p_stat_id   uuid,
  p_league_id uuid
)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_settings jsonb;
  v_stats    player_game_stats%ROWTYPE;
  v_total    numeric := 0;
BEGIN
  SELECT scoring_settings INTO v_settings
    FROM leagues WHERE id = p_league_id;

  SELECT pgs.* INTO v_stats
    FROM player_game_stats pgs
    INNER JOIN nba_games g ON g.id = pgs.game_id
    WHERE pgs.id = p_stat_id
      AND public.is_regular_season_game_id(g.nba_game_id);

  IF NOT FOUND OR v_stats.did_not_play THEN
    RETURN 0;
  END IF;

  v_total :=
    COALESCE(v_stats.points,                  0) * COALESCE((v_settings->>'points')::numeric,                0) +
    COALESCE(v_stats.rebounds,                0) * COALESCE((v_settings->>'rebounds')::numeric,              0) +
    COALESCE(v_stats.assists,                 0) * COALESCE((v_settings->>'assists')::numeric,               0) +
    COALESCE(v_stats.steals,                  0) * COALESCE((v_settings->>'steals')::numeric,                0) +
    COALESCE(v_stats.blocks,                  0) * COALESCE((v_settings->>'blocks')::numeric,                0) +
    COALESCE(v_stats.turnovers,               0) * COALESCE((v_settings->>'turnovers')::numeric,             0) +
    COALESCE(v_stats.three_pointers_made,     0) * COALESCE((v_settings->>'three_pointers_made')::numeric,   0) +
    COALESCE(v_stats.field_goals_made,        0) * COALESCE((v_settings->>'field_goals_made')::numeric,      0) +
    COALESCE(v_stats.field_goals_attempted,   0) * COALESCE((v_settings->>'field_goals_attempted')::numeric, 0) +
    COALESCE(v_stats.free_throws_made,        0) * COALESCE((v_settings->>'free_throws_made')::numeric,      0) +
    COALESCE(v_stats.free_throws_attempted,   0) * COALESCE((v_settings->>'free_throws_attempted')::numeric, 0) +
    CASE WHEN v_stats.double_double = true
      THEN COALESCE((v_settings->>'double_double')::numeric, 0) ELSE 0 END +
    CASE WHEN v_stats.triple_double = true
      THEN COALESCE((v_settings->>'triple_double')::numeric, 0) ELSE 0 END;

  RETURN v_total;
END;
$$;

CREATE OR REPLACE VIEW v_fantasy_points
  WITH (security_invoker = true)
AS
SELECT
  pgs.id           AS stat_id,
  l.id             AS league_id,
  pgs.player_id,
  pgs.game_id,
  pgs.season_year,
  pgs.week_number,
  CASE WHEN pgs.did_not_play THEN 0::numeric ELSE
    COALESCE(pgs.points                * (l.scoring_settings->>'points')::numeric,                0) +
    COALESCE(pgs.rebounds              * (l.scoring_settings->>'rebounds')::numeric,              0) +
    COALESCE(pgs.assists               * (l.scoring_settings->>'assists')::numeric,               0) +
    COALESCE(pgs.steals                * (l.scoring_settings->>'steals')::numeric,                0) +
    COALESCE(pgs.blocks                * (l.scoring_settings->>'blocks')::numeric,                0) +
    COALESCE(pgs.turnovers             * (l.scoring_settings->>'turnovers')::numeric,             0) +
    COALESCE(pgs.three_pointers_made   * (l.scoring_settings->>'three_pointers_made')::numeric,   0) +
    COALESCE(pgs.field_goals_made      * (l.scoring_settings->>'field_goals_made')::numeric,      0) +
    COALESCE(pgs.field_goals_attempted * (l.scoring_settings->>'field_goals_attempted')::numeric, 0) +
    COALESCE(pgs.free_throws_made      * (l.scoring_settings->>'free_throws_made')::numeric,      0) +
    COALESCE(pgs.free_throws_attempted * (l.scoring_settings->>'free_throws_attempted')::numeric, 0) +
    CASE WHEN pgs.double_double = true
      THEN COALESCE((l.scoring_settings->>'double_double')::numeric, 0) ELSE 0 END +
    CASE WHEN pgs.triple_double = true
      THEN COALESCE((l.scoring_settings->>'triple_double')::numeric, 0) ELSE 0 END
  END AS fantasy_points
FROM player_game_stats pgs
INNER JOIN nba_games g
  ON g.id = pgs.game_id
  AND public.is_regular_season_game_id(g.nba_game_id)
CROSS JOIN leagues l;

GRANT SELECT ON v_fantasy_points TO authenticated;

CREATE OR REPLACE VIEW v_player_avg_fantasy_points
  WITH (security_invoker = true)
AS
SELECT
  fp.league_id,
  fp.player_id,
  fp.season_year,
  ROUND(AVG(fp.fantasy_points)::numeric, 2) AS avg_fantasy_points
FROM v_fantasy_points fp
INNER JOIN player_game_stats pgs ON pgs.id = fp.stat_id AND NOT pgs.did_not_play
GROUP BY fp.league_id, fp.player_id, fp.season_year;

GRANT SELECT ON v_player_avg_fantasy_points TO authenticated, anon;

DROP VIEW IF EXISTS public.mv_player_season_averages;
DROP MATERIALIZED VIEW IF EXISTS analytics.mv_player_season_averages;

CREATE MATERIALIZED VIEW analytics.mv_player_season_averages AS
SELECT
  pgs.player_id,
  pgs.season_year,
  COUNT(*)                                             AS games_played,
  ROUND(AVG(pgs.points)::numeric,               1)     AS avg_points,
  ROUND(AVG(pgs.rebounds)::numeric,             1)     AS avg_rebounds,
  ROUND(AVG(pgs.assists)::numeric,              1)     AS avg_assists,
  ROUND(AVG(pgs.steals)::numeric,               2)     AS avg_steals,
  ROUND(AVG(pgs.blocks)::numeric,               2)     AS avg_blocks,
  ROUND(AVG(pgs.turnovers)::numeric,            2)     AS avg_turnovers,
  ROUND(AVG(pgs.three_pointers_made)::numeric,  2)     AS avg_three_pointers_made,
  ROUND(AVG(pgs.field_goals_made)::numeric,     2)     AS avg_field_goals_made,
  ROUND(AVG(pgs.field_goals_attempted)::numeric,2)     AS avg_field_goals_attempted,
  ROUND(AVG(pgs.free_throws_made)::numeric,     2)     AS avg_free_throws_made,
  ROUND(AVG(pgs.free_throws_attempted)::numeric,2)     AS avg_free_throws_attempted,
  ROUND(AVG(pgs.minutes_played)::numeric,       1)     AS avg_minutes_played,
  COUNT(*) FILTER (WHERE pgs.double_double = true)     AS double_doubles,
  COUNT(*) FILTER (WHERE pgs.triple_double = true)     AS triple_doubles
FROM player_game_stats pgs
INNER JOIN nba_games g
  ON g.id = pgs.game_id
  AND public.is_regular_season_game_id(g.nba_game_id)
WHERE NOT pgs.did_not_play
GROUP BY pgs.player_id, pgs.season_year;

CREATE UNIQUE INDEX idx_mv_player_season_averages
  ON analytics.mv_player_season_averages(player_id, season_year);

CREATE OR REPLACE VIEW public.mv_player_season_averages
  WITH (security_invoker = true)
AS
  SELECT * FROM analytics.mv_player_season_averages;

GRANT SELECT ON analytics.mv_player_season_averages TO authenticated, anon;
GRANT SELECT ON public.mv_player_season_averages TO authenticated, anon;
