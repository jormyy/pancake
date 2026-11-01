ALTER TABLE private.live_poll_game_state ADD COLUMN checkpoint_at timestamptz;

CREATE OR REPLACE FUNCTION public.get_live_checkpoint_work(p_now timestamptz DEFAULT now())
RETURNS TABLE(id uuid,nba_game_id text,game_date date,status text,game_time timestamptz,home_team text,away_team text,
  checkpoint_at timestamptz,needs_final_check boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT game.id,game.nba_game_id,game.game_date,game.status,game.game_time,game.home_team,game.away_team,attempt.checkpoint_at,
    game.status='Final' AND (game.stats_synced_at IS NULL OR game.stats_synced_at<=p_now-interval '30 minutes')
      AND (attempt.stats_attempted_at IS NULL OR attempt.stats_attempted_at<=p_now-interval '30 minutes')
  FROM public.nba_games game LEFT JOIN private.live_poll_game_state attempt ON attempt.game_id=game.id
  WHERE game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
    AND game.nba_game_id LIKE '002%' AND private.lineup_game_available(game.status,game.game_status_text)
    AND (game.status='InProgress' OR game.status='Scheduled' AND (
      COALESCE(game.game_time,game.started_at)<=p_now+interval '2 minutes'
      OR COALESCE(game.game_time,game.started_at) IS NULL AND (p_now AT TIME ZONE 'America/New_York')::time>=time '11:00')
      OR game.status='Final' AND (game.stats_synced_at IS NULL OR game.stats_synced_at<=p_now-interval '30 minutes')
        AND (attempt.stats_attempted_at IS NULL OR attempt.stats_attempted_at<=p_now-interval '30 minutes'))
  ORDER BY game.game_date,game.id;
$$;

ALTER FUNCTION public.get_live_checkpoint_work(timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_live_checkpoint_work(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_live_checkpoint_work(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.record_live_checkpoint(p_holder uuid,p_game_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.lock_live_poll_holder(p_holder);
  INSERT INTO private.live_poll_game_state(game_id,checkpoint_at)
    SELECT id,clock_timestamp() FROM public.nba_games WHERE id=ANY(p_game_ids) ORDER BY id
    ON CONFLICT(game_id) DO UPDATE SET checkpoint_at=EXCLUDED.checkpoint_at;
END;
$$;

ALTER FUNCTION public.record_live_checkpoint(uuid,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_live_checkpoint(uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_live_checkpoint(uuid,uuid[]) TO service_role;
