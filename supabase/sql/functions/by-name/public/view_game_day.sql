-- Canonical SQL source for public.view_game_day.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_game_day(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; selected date; games jsonb; started_teams jsonb; opponents jsonb; stats jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  selected := COALESCE((p_params->>'date')::date, (context->>'today')::date);
  WITH slate AS MATERIALIZED (SELECT * FROM public.nba_games WHERE game_date = selected), teams AS (
    SELECT id, home_team AS team, away_team AS opponent, true AS home, status IN ('InProgress','Final') OR game_time <= now() OR started_at <= now() AS started FROM slate
    UNION ALL SELECT id, away_team, home_team, false, status IN ('InProgress','Final') OR game_time <= now() OR started_at <= now() FROM slate
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'nba_game_id', nba_game_id, 'home_team', home_team,
      'away_team', away_team, 'home_score', home_score, 'away_score', away_score, 'status', status,
      'game_status_text', game_status_text, 'game_date', game_date, 'game_time',game_time) ORDER BY game_time, id) FROM slate WHERE nba_game_id LIKE '002%'), '[]'),
    COALESCE(jsonb_agg(DISTINCT team) FILTER (WHERE started AND team IS NOT NULL), '[]'),
    COALESCE(jsonb_object_agg(team, jsonb_build_object('opponent', opponent, 'isHome', home) ORDER BY id) FILTER (WHERE team IS NOT NULL AND opponent IS NOT NULL), '{}')
  INTO games, started_teams, opponents FROM teams;
  SELECT COALESCE(jsonb_object_agg(stat.player_id::text, jsonb_build_object('points', COALESCE(stat.points, 0),
    'rebounds', COALESCE(stat.rebounds, 0), 'assists', COALESCE(stat.assists, 0), 'steals', COALESCE(stat.steals, 0),
    'blocks', COALESCE(stat.blocks, 0), 'turnovers', stat.turnovers, 'threeMade', COALESCE(stat.three_pointers_made, 0),
    'fgMade', COALESCE(stat.field_goals_made, 0), 'fgAttempted', COALESCE(stat.field_goals_attempted, 0),
    'ftMade', COALESCE(stat.free_throws_made, 0), 'ftAttempted', COALESCE(stat.free_throws_attempted, 0),
    'fouls', COALESCE(stat.personal_fouls, 0), 'doubleDouble', COALESCE(stat.double_double, false),
    'tripleDouble', COALESCE(stat.triple_double, false), 'minutesPlayed', stat.minutes_played, 'didNotPlay', COALESCE(stat.did_not_play, false)) ORDER BY stat.id), '{}')
  INTO stats FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id AND game.nba_game_id LIKE '002%'
  WHERE stat.game_date = selected AND stat.player_id IN (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_params->'playerIds', '[]')));
  RETURN jsonb_build_object('games', games, 'startedTeams', started_teams, 'teamMatchups', opponents, 'liveStats', stats);
END;
$$;
