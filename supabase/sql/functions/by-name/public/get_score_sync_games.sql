CREATE OR REPLACE FUNCTION public.get_score_sync_games(p_start_date date,p_end_date date,p_season_year int DEFAULT NULL)
RETURNS TABLE(id uuid,nba_game_id text,game_date date,season_year int,week_number int,status text,stats_synced_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT game.id,game.nba_game_id,game.game_date,game.season_year,game.week_number,game.status,game.stats_synced_at
  FROM public.nba_games game
  WHERE game.game_date BETWEEN p_start_date AND p_end_date
    AND (p_season_year IS NULL OR game.season_year=p_season_year)
    AND public.is_regular_season_game_id(game.nba_game_id)
    AND private.lineup_game_available(game.status,game.game_status_text);
$$;
