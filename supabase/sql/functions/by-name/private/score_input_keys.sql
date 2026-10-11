CREATE OR REPLACE FUNCTION private.score_input_keys(p_season_id uuid, p_week int)
RETURNS TABLE(scope text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH season AS (
    SELECT id, league_id, season_year FROM public.league_seasons WHERE id = p_season_id
  ), bounds AS (
    SELECT CASE WHEN bool_or(matchup_type = 'regular_season') THEN 1 ELSE p_week END AS first_week,
      COALESCE(max(COALESCE(end_week_number, week_number)), p_week) AS last_week
    FROM public.matchups WHERE league_season_id = p_season_id AND week_number = p_week
  ), keys AS (
    SELECT unnest(ARRAY['calendar:' || season_year, 'league:' || league_id, 'season:' || id]) AS scope FROM season
    UNION ALL SELECT 'player:' || dependency.player_id FROM (
      SELECT player_id FROM public.roster_players WHERE league_season_id = p_season_id
      UNION SELECT player_id FROM public.roster_transactions WHERE league_season_id = p_season_id
    ) dependency
    UNION ALL SELECT 'nba:' || season_year || ':' || week FROM season, bounds, generate_series(first_week, last_week) week
    UNION ALL SELECT 'lineup:' || id || ':' || week FROM season, bounds, generate_series(first_week, last_week) week
    UNION ALL SELECT 'result:' || id || ':' || week FROM season, bounds, generate_series(first_week, p_week) week
  ) SELECT DISTINCT scope FROM keys ORDER BY scope;
$$;
