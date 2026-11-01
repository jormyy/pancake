CREATE OR REPLACE FUNCTION public.get_live_checkpoint_inputs(p_game_ids uuid[], p_now timestamptz DEFAULT now())
RETURNS TABLE (
  id uuid, nba_game_id text, game_date date, season_year int, week_number int, status text,
  game_time timestamptz, started_at timestamptz, home_team text, away_team text,
  home_score int, away_score int, game_status_text text, stats_synced_at timestamptz,
  needs_scoreboard boolean, needs_stats boolean, live_cache jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.nba_games game
    WHERE game.id=ANY(p_game_ids) AND game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
      AND game.nba_game_id LIKE '002%'
      AND (game.status='InProgress' OR game.status='Scheduled' AND (
        COALESCE(game.game_time,game.started_at)<=p_now+interval '2 minutes'
        OR COALESCE(game.game_time,game.started_at) IS NULL AND (
          (p_now AT TIME ZONE 'America/New_York')::time>=time '11:00'
          OR game.game_date<(p_now AT TIME ZONE 'America/New_York')::date))
        OR game.status='Final' AND (game.stats_synced_at IS NULL OR game.stats_synced_at<=p_now-interval '30 minutes'))) THEN RETURN; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT game.*,
      game.status = 'InProgress' OR (
        game.status = 'Scheduled'
        AND (
          COALESCE(game.game_time,game.started_at) BETWEEN p_now-interval '45 minutes' AND p_now+interval '2 minutes'
          OR (
            (COALESCE(game.game_time,game.started_at) < p_now-interval '45 minutes'
              OR (COALESCE(game.game_time,game.started_at) IS NULL AND
                ((p_now AT TIME ZONE 'America/New_York')::time >= time '11:00' OR game.game_date < (p_now AT TIME ZONE 'America/New_York')::date)))
            AND (attempt.checked_at IS NULL OR attempt.checked_at <= p_now-interval '30 minutes')
          )
        )
      ) AS board_due,
      game.status = 'InProgress' OR (game.status = 'Final'
        AND (game.stats_synced_at IS NULL OR game.stats_synced_at <= p_now-interval '30 minutes')
        AND (attempt.stats_attempted_at IS NULL OR attempt.stats_attempted_at <= p_now-interval '30 minutes')) AS stats_due
    FROM public.nba_games game
    LEFT JOIN private.live_poll_game_state attempt ON attempt.game_id=game.id
    WHERE game.id=ANY(p_game_ids) AND game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
      AND game.nba_game_id LIKE '002%'
      AND private.lineup_game_available(game.status,game.game_status_text)
  )
  SELECT game.id,game.nba_game_id,game.game_date,game.season_year,game.week_number,game.status,
    game.game_time,game.started_at,game.home_team,game.away_team,game.home_score,game.away_score,
    game.game_status_text,game.stats_synced_at,game.board_due,game.stats_due,
    jsonb_build_object('snapshot',feed.stats_snapshot,'players',coalesce((
      SELECT jsonb_agg(jsonb_build_object('provider_id',player.nba_id,'player_id',player.id,'nba_team',member.nba_team) ORDER BY player.id)
      FROM private.player_game_memberships member JOIN public.players player ON player.id=member.player_id
      WHERE member.game_id=game.id AND player.nba_id IS NOT NULL AND member.nba_team IS NOT NULL
    ),'[]'::jsonb))
  FROM candidates game
  LEFT JOIN private.live_feed_state feed ON feed.game_id=game.id
  WHERE game.board_due OR game.stats_due
  ORDER BY game.game_date,game.id;
END;
$$;
