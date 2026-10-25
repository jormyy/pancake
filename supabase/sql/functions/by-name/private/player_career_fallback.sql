CREATE OR REPLACE FUNCTION private.player_career_fallback(p_player_id uuid, p_years_exp integer, p_season_year integer)
RETURNS TABLE(base integer, base_season integer, source text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH appeared AS (
    SELECT g.season_year,g.game_date
    FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
    WHERE s.player_id=p_player_id AND g.season_year<=p_season_year
      AND public.is_regular_season_game_id(g.nba_game_id) AND private.player_game_appeared(s)
  ), coverage AS (
    SELECT count(*) FILTER(WHERE season_year>=2021 AND game_date>=DATE '2020-12-22') AS games,
      count(DISTINCT season_year) FILTER(WHERE season_year<p_season_year) AS completed_seasons,
      count(*) FILTER(WHERE season_year<p_season_year) AS past_games,
      count(*) FILTER(WHERE season_year<2021 OR game_date<DATE '2020-12-22') AS before_coverage
    FROM appeared
  ), resolved AS (
    SELECT CASE WHEN p_years_exp=0 AND past_games=0 THEN 'rookie'
      WHEN p_years_exp>0 AND completed_seasons=p_years_exp AND before_coverage=0 THEN 'coverage'
      WHEN games>=65 THEN 'threshold' END AS source FROM coverage
  )
  SELECT CASE WHEN source IS NOT NULL THEN 0 END,
    CASE WHEN source='rookie' THEN p_season_year-1 WHEN source IS NOT NULL THEN 2020 END,source FROM resolved;
$$;
