CREATE OR REPLACE FUNCTION private.fantasy_points_rows(p_league_id uuid, p_stat_ids uuid[])
RETURNS TABLE(stat_id uuid, points numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT stat.id, round(
      COALESCE(stat.points,0)*COALESCE((league.scoring_settings->>'points')::numeric,0) +
      COALESCE(stat.rebounds,0)*COALESCE((league.scoring_settings->>'rebounds')::numeric,0) +
      COALESCE(stat.assists,0)*COALESCE((league.scoring_settings->>'assists')::numeric,0) +
      COALESCE(stat.steals,0)*COALESCE((league.scoring_settings->>'steals')::numeric,0) +
      COALESCE(stat.blocks,0)*COALESCE((league.scoring_settings->>'blocks')::numeric,0) +
      COALESCE(stat.turnovers,0)*COALESCE((league.scoring_settings->>'turnovers')::numeric,0) +
      COALESCE(stat.three_pointers_made,0)*COALESCE((league.scoring_settings->>'three_pointers_made')::numeric,0) +
      COALESCE(stat.field_goals_made,0)*COALESCE((league.scoring_settings->>'field_goals_made')::numeric,0) +
      COALESCE(stat.field_goals_attempted,0)*COALESCE((league.scoring_settings->>'field_goals_attempted')::numeric,0) +
      COALESCE(stat.free_throws_made,0)*COALESCE((league.scoring_settings->>'free_throws_made')::numeric,0) +
      COALESCE(stat.free_throws_attempted,0)*COALESCE((league.scoring_settings->>'free_throws_attempted')::numeric,0) +
      CASE WHEN stat.double_double THEN COALESCE((league.scoring_settings->>'double_double')::numeric,0) ELSE 0 END +
      CASE WHEN stat.triple_double THEN COALESCE((league.scoring_settings->>'triple_double')::numeric,0) ELSE 0 END
    ,2)
  FROM public.player_game_stats stat
  JOIN public.nba_games game ON game.id=stat.game_id
  JOIN public.leagues league ON league.id=p_league_id
  WHERE stat.id = ANY(p_stat_ids)
    AND public.is_regular_season_game_id(game.nba_game_id)
    AND NOT stat.did_not_play
$$;
