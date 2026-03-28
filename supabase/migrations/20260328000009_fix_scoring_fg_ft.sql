-- Fix fantasy scoring to include FGM, FGA, FTM, FTA
-- These were missing from both compute_fantasy_points() and v_fantasy_points

-- Update the scalar function
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

  SELECT * INTO v_stats
    FROM player_game_stats WHERE id = p_stat_id;

  IF v_stats.did_not_play THEN
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

-- Update the view
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
CROSS JOIN leagues l;

GRANT SELECT ON v_fantasy_points TO authenticated;
