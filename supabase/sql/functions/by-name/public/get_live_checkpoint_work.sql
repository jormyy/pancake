CREATE OR REPLACE FUNCTION public.get_live_checkpoint_work(p_now timestamptz DEFAULT now())
RETURNS TABLE(id uuid,nba_game_id text,game_date date,status text,game_time timestamptz,home_team text,away_team text,
  checkpoint_at timestamptz,needs_final_check boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH candidates AS (
    SELECT game.*,attempt.checkpoint_at,
      game.status='InProgress' OR game.status='Scheduled' AND (
        COALESCE(game.game_time,game.started_at) BETWEEN p_now-interval '45 minutes' AND p_now+interval '2 minutes'
        OR (COALESCE(game.game_time,game.started_at)<p_now-interval '45 minutes'
          OR COALESCE(game.game_time,game.started_at) IS NULL AND (
            (p_now AT TIME ZONE 'America/New_York')::time>=time '11:00'
            OR game.game_date<(p_now AT TIME ZONE 'America/New_York')::date))
          AND (attempt.checked_at IS NULL OR attempt.checked_at<=p_now-interval '30 minutes')) AS board_due,
      game.status='InProgress' OR game.status='Final'
        AND (game.stats_synced_at IS NULL OR game.stats_synced_at<=p_now-interval '30 minutes')
        AND (attempt.stats_attempted_at IS NULL OR attempt.stats_attempted_at<=p_now-interval '30 minutes') AS stats_due
    FROM public.nba_games game LEFT JOIN private.live_poll_game_state attempt ON attempt.game_id=game.id
    WHERE game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
      AND game.nba_game_id LIKE '002%' AND private.lineup_game_available(game.status,game.game_status_text)
  )
  SELECT game.id,game.nba_game_id,game.game_date,game.status,game.game_time,game.home_team,game.away_team,
    game.checkpoint_at,game.status='Final' AND game.stats_due
  FROM candidates game WHERE game.board_due OR game.stats_due ORDER BY game.game_date,game.id;
$$;
