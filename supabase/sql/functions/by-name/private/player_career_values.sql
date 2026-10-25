CREATE OR REPLACE FUNCTION private.player_career_values(p_player_id uuid, p_years_exp integer, p_prior integer)
RETURNS TABLE(prior integer, games integer) LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH observed AS (
    SELECT count(*) FILTER (WHERE s.minutes_played > 0 AND NOT s.did_not_play
      AND g.season_year >= 2021 AND g.game_date >= DATE '2020-12-22')::integer AS games,
      min(g.season_year) AS first_season
    FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
    WHERE s.player_id=p_player_id AND public.is_regular_season_game_id(g.nba_game_id)
  ), resolved AS (
    SELECT games, coalesce(p_prior, CASE WHEN p_years_exp >= 0
      AND public.current_season_year_et() - p_years_exp >= 2021
      AND coalesce(first_season, 2021) >= 2021 THEN 0 END) AS prior FROM observed
  )
  SELECT prior, CASE WHEN prior IS NOT NULL THEN prior + games WHEN games >= 65 THEN games END FROM resolved;
$$;
