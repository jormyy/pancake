SET lock_timeout = '5s';
SET statement_timeout = '60s';
CREATE TABLE private.live_poll_game_state (
  game_id uuid PRIMARY KEY REFERENCES public.nba_games(id) ON DELETE CASCADE,
  checked_at timestamptz,
  stats_attempted_at timestamptz
);
REVOKE ALL ON private.live_poll_game_state FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.lock_live_poll_holder(p_holder uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.live_poll_leases WHERE lock_key = 779001
    AND holder_id = p_holder AND expires_at > clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Live poll lease expired or changed' USING ERRCODE='40001'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enforce_live_poll_lease()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_holder text := NULLIF(COALESCE(NULLIF(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb)->>'x-pancake-live-holder','');
BEGIN
  IF v_holder IS NOT NULL THEN PERFORM private.lock_live_poll_holder(v_holder::uuid); END IF;
  RETURN NULL;
END;
$$;

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
          COALESCE(game.game_time,game.started_at) BETWEEN p_now-interval '10 minutes' AND p_now+interval '2 minutes'
          OR (
            (COALESCE(game.game_time,game.started_at) < p_now-interval '10 minutes'
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
  ), primary_work AS (
    SELECT * FROM candidates WHERE board_due OR (stats_due AND stats_synced_at IS NULL)
  )
  SELECT game.id,game.nba_game_id,game.game_date,game.season_year,game.week_number,game.status,
    game.game_time,game.started_at,game.home_team,game.away_team,game.home_score,game.away_score,
    game.game_status_text,game.stats_synced_at,game.board_due,game.stats_due
  FROM candidates game
  WHERE game.board_due OR (game.stats_due AND (game.stats_synced_at IS NULL OR EXISTS(SELECT 1 FROM primary_work)))
  ORDER BY game.game_date,game.id;
$$;

CREATE OR REPLACE FUNCTION public.record_live_poll_attempts(
  p_holder uuid, p_checked_ids uuid[] DEFAULT ARRAY[]::uuid[], p_stats_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.lock_live_poll_holder(p_holder);
  INSERT INTO private.live_poll_game_state(game_id,checked_at,stats_attempted_at)
    SELECT game.id,
      CASE WHEN game.id=ANY(p_checked_ids) THEN clock_timestamp() END,
      CASE WHEN game.id=ANY(p_stats_ids) AND game.status='Final' THEN clock_timestamp() END
    FROM public.nba_games game WHERE game.id=ANY(p_checked_ids) OR (game.id=ANY(p_stats_ids) AND game.status='Final')
    ORDER BY game.id
    ON CONFLICT(game_id) DO UPDATE SET
      checked_at=COALESCE(EXCLUDED.checked_at,live_poll_game_state.checked_at),
      stats_attempted_at=COALESCE(EXCLUDED.stats_attempted_at,live_poll_game_state.stats_attempted_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.live_poll_leases WHERE lock_key=779001 AND expires_at>clock_timestamp())
    AND EXISTS (SELECT 1 FROM public.get_live_poll_work()) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END;
$$;
CREATE TRIGGER guard_live_poll_lease BEFORE INSERT OR UPDATE OR DELETE ON public.nba_games
  FOR EACH STATEMENT EXECUTE FUNCTION private.enforce_live_poll_lease();
CREATE TRIGGER guard_live_poll_lease BEFORE INSERT OR UPDATE OR DELETE ON public.player_game_stats
  FOR EACH STATEMENT EXECUTE FUNCTION private.enforce_live_poll_lease();
CREATE TRIGGER guard_live_poll_lease BEFORE INSERT OR UPDATE OR DELETE ON public.matchups
  FOR EACH STATEMENT EXECUTE FUNCTION private.enforce_live_poll_lease();
CREATE TRIGGER guard_live_poll_lease BEFORE INSERT OR UPDATE OR DELETE ON public.standings
  FOR EACH STATEMENT EXECUTE FUNCTION private.enforce_live_poll_lease();

REVOKE ALL ON FUNCTION private.lock_live_poll_holder(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.enforce_live_poll_lease() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_live_poll_work(timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_live_poll_attempts(uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_live_poll_work(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_live_poll_attempts(uuid,uuid[],uuid[]) TO service_role;
DO $cron$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.schedule('nba-live-poll','*/2 * * * *',$job$SELECT public.invoke_live_poll_if_due()$job$);
  END IF;
END;
$cron$;
RESET statement_timeout;
RESET lock_timeout;
