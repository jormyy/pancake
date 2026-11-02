CREATE OR REPLACE FUNCTION public.get_live_checkpoint_inputs(p_game_ids uuid[],p_now timestamptz DEFAULT now())
RETURNS TABLE(id uuid,nba_game_id text,game_date date,season_year int,week_number int,status text,
  game_time timestamptz,started_at timestamptz,home_team text,away_team text,home_score int,away_score int,
  game_status_text text,stats_synced_at timestamptz,needs_scoreboard boolean,needs_stats boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT game.id,game.nba_game_id,game.game_date,game.season_year,game.week_number,game.status,
    game.game_time,game.started_at,game.home_team,game.away_team,game.home_score,game.away_score,
    game.game_status_text,game.stats_synced_at,game.status<>'Final',true
  FROM public.nba_games game WHERE game.id=ANY(p_game_ids)
    AND game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
    AND game.nba_game_id LIKE '002%' AND private.lineup_game_available(game.status,game.game_status_text)
  ORDER BY game.game_date,game.id;
$$;
