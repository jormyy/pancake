BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.get_live_poll_work(p_now timestamptz DEFAULT now())
RETURNS TABLE (
  id uuid, nba_game_id text, game_date date, season_year int, week_number int, status text,
  game_time timestamptz, started_at timestamptz, home_team text, away_team text,
  home_score int, away_score int, game_status_text text, stats_synced_at timestamptz,
  needs_scoreboard boolean, needs_stats boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
    WHERE game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
      AND game.nba_game_id LIKE '002%'
      AND private.lineup_game_available(game.status,game.game_status_text)
  )
  SELECT game.id,game.nba_game_id,game.game_date,game.season_year,game.week_number,game.status,
    game.game_time,game.started_at,game.home_team,game.away_team,game.home_score,game.away_score,
    game.game_status_text,game.stats_synced_at,game.board_due,game.stats_due
  FROM candidates game
  WHERE game.board_due OR game.stats_due
  ORDER BY game.game_date,game.id;
$$;

CREATE OR REPLACE FUNCTION public.queue_daily_stat_corrections(p_now timestamptz DEFAULT now())
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_local timestamp := p_now AT TIME ZONE 'America/New_York';
  v_start date := v_local::date - 7;
  v_end date := v_local::date - 1;
  v_job_type text := format('sync_stats_range:%s:%s', v_start, v_end);
  v_job_id uuid;
BEGIN
  IF p_now IS NULL OR v_local::time < time '06:20' THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pancake:daily-stat-corrections', 0));

  SELECT id INTO v_job_id
  FROM public.sync_jobs
  WHERE job_type = v_job_type
  ORDER BY created_at DESC, id
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    RETURN v_job_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nba_games
    WHERE game_date BETWEEN v_start AND v_end
      AND nba_game_id LIKE '002%'
      AND status = 'Final'
  ) THEN
    RETURN NULL;
  END IF;

  v_job_id := public.create_or_resume_stats_sync_job_atomic(v_start, v_end);
  PERFORM public.invoke_stats_sync_dispatch_if_due();
  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_daily_stat_corrections(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_daily_stat_corrections(timestamptz) TO service_role;
SELECT cron.schedule('daily-stat-corrections', '*/15 * * * *', 'SELECT public.queue_daily_stat_corrections()');
COMMIT;
