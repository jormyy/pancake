CREATE OR REPLACE FUNCTION private.trade_value_fantasy_averages(p_league_id uuid,p_season_year integer,p_player_ids uuid[] DEFAULT NULL)
RETURNS TABLE(player_id uuid,avg_fantasy_points numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE weights record; rounded_players uuid[]; game_ids uuid[];
BEGIN
  SELECT COALESCE((scoring_settings->>'points')::numeric,0) AS points,
    COALESCE((scoring_settings->>'rebounds')::numeric,0) AS rebounds,
    COALESCE((scoring_settings->>'assists')::numeric,0) AS assists,
    COALESCE((scoring_settings->>'steals')::numeric,0) AS steals,
    COALESCE((scoring_settings->>'blocks')::numeric,0) AS blocks,
    COALESCE((scoring_settings->>'turnovers')::numeric,0) AS turnovers,
    COALESCE((scoring_settings->>'three_pointers_made')::numeric,0) AS three_pointers_made,
    COALESCE((scoring_settings->>'field_goals_made')::numeric,0) AS field_goals_made,
    COALESCE((scoring_settings->>'field_goals_attempted')::numeric,0) AS field_goals_attempted,
    COALESCE((scoring_settings->>'free_throws_made')::numeric,0) AS free_throws_made,
    COALESCE((scoring_settings->>'free_throws_attempted')::numeric,0) AS free_throws_attempted,
    scoring_settings->>'double_double' AS double_double,scoring_settings->>'triple_double' AS triple_double
    INTO weights FROM public.leagues WHERE id=p_league_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT array_agg(totals.player_id) INTO rounded_players FROM analytics.player_season_totals totals
    WHERE totals.season_year=p_season_year AND (p_player_ids IS NULL OR totals.player_id=ANY(p_player_ids))
      AND (weights.points<>round(weights.points,2) OR
      weights.rebounds<>round(weights.rebounds,2) OR
      weights.assists<>round(weights.assists,2) OR
      weights.steals<>round(weights.steals,2) OR
      weights.blocks<>round(weights.blocks,2) OR
      weights.turnovers<>round(weights.turnovers,2) OR
      weights.three_pointers_made<>round(weights.three_pointers_made,2) OR
      weights.field_goals_made<>round(weights.field_goals_made,2) OR
      weights.field_goals_attempted<>round(weights.field_goals_attempted,2) OR
      weights.free_throws_made<>round(weights.free_throws_made,2) OR
      weights.free_throws_attempted<>round(weights.free_throws_attempted,2) OR
      (totals.double_double>0 AND COALESCE(weights.double_double::numeric,0)<>round(COALESCE(weights.double_double::numeric,0),2)) OR
      (totals.triple_double>0 AND COALESCE(weights.triple_double::numeric,0)<>round(COALESCE(weights.triple_double::numeric,0),2)));
  IF rounded_players IS NOT NULL THEN
    SELECT array_agg(game.id) INTO game_ids FROM public.nba_games game
      WHERE game.season_year=p_season_year AND public.is_regular_season_game_id(game.nba_game_id);
  END IF;
  RETURN QUERY
  WITH rounded AS MATERIALIZED (
    SELECT stats.player_id,round(avg(round(COALESCE(stats.points*weights.points,0) +
        COALESCE(stats.rebounds*weights.rebounds,0) +
        COALESCE(stats.assists*weights.assists,0) +
        COALESCE(stats.steals*weights.steals,0) +
        COALESCE(stats.blocks*weights.blocks,0) +
        COALESCE(stats.turnovers*weights.turnovers,0) +
        COALESCE(stats.three_pointers_made*weights.three_pointers_made,0) +
        COALESCE(stats.field_goals_made*weights.field_goals_made,0) +
        COALESCE(stats.field_goals_attempted*weights.field_goals_attempted,0) +
        COALESCE(stats.free_throws_made*weights.free_throws_made,0) +
        COALESCE(stats.free_throws_attempted*weights.free_throws_attempted,0) +
        CASE WHEN stats.double_double THEN COALESCE(weights.double_double::numeric,0) ELSE 0 END +
        CASE WHEN stats.triple_double THEN COALESCE(weights.triple_double::numeric,0) ELSE 0 END,2)),2) AS average
    FROM unnest(game_ids) AS game(id)
    CROSS JOIN LATERAL (
      SELECT stats.* FROM public.player_game_stats stats
      WHERE stats.game_id=game.id AND stats.player_id=ANY(rounded_players)
        AND stats.season_year=p_season_year AND NOT stats.did_not_play
      OFFSET 0
    ) stats
    GROUP BY stats.player_id
  )
  SELECT totals.player_id,CASE WHEN totals.player_id=ANY(rounded_players) THEN rounded.average
    ELSE round((totals.points*weights.points +
      totals.rebounds*weights.rebounds +
      totals.assists*weights.assists +
      totals.steals*weights.steals +
      totals.blocks*weights.blocks +
      totals.turnovers*weights.turnovers +
      totals.three_pointers_made*weights.three_pointers_made +
      totals.field_goals_made*weights.field_goals_made +
      totals.field_goals_attempted*weights.field_goals_attempted +
      totals.free_throws_made*weights.free_throws_made +
      totals.free_throws_attempted*weights.free_throws_attempted +
      CASE WHEN totals.double_double>0 THEN totals.double_double*COALESCE(weights.double_double::numeric,0) ELSE 0 END +
      CASE WHEN totals.triple_double>0 THEN totals.triple_double*COALESCE(weights.triple_double::numeric,0) ELSE 0 END)/NULLIF(totals.games_played,0),2) END
    FROM analytics.player_season_totals totals LEFT JOIN rounded ON rounded.player_id=totals.player_id
    WHERE totals.season_year=p_season_year AND (p_player_ids IS NULL OR totals.player_id=ANY(p_player_ids));
END;
$$;
REVOKE ALL ON FUNCTION private.trade_value_fantasy_averages(uuid,integer,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
