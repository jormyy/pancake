CREATE OR REPLACE FUNCTION private.enqueue_pre_tipoff_optimizer(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_window record; v_fingerprint text; v_today date:=(p_now AT TIME ZONE 'America/New_York')::date;
BEGIN
  FOR v_window IN
    SELECT tipoff_at FROM (
    SELECT DISTINCT g.game_time AS tipoff_at
      FROM public.nba_games g
     WHERE g.game_date = v_today
       AND g.status = 'Scheduled'
       AND private.lineup_game_available(g.status, g.game_status_text)
       AND g.game_time > p_now
       AND g.game_time <= p_now + interval '2 minutes'
       AND (g.started_at IS NULL OR g.started_at > p_now)
       AND EXISTS (
         SELECT 1 FROM public.lineup_optimizer_settings s
         JOIN public.league_seasons ls ON ls.id = s.league_season_id
         JOIN public.leagues l ON l.id = s.league_id
         WHERE s.enabled AND ls.is_current AND ls.season_year = g.season_year
           AND l.status IN ('active', 'playoffs')
       )
    UNION
    SELECT d.tipoff_at FROM public.lineup_tipoff_dispatches d
    WHERE d.game_date = v_today AND d.tipoff_at > p_now - interval '1 minute'
      AND d.tipoff_at <= p_now + interval '2 minutes'
    ) windows ORDER BY tipoff_at
  LOOP
    IF v_fingerprint IS NULL THEN v_fingerprint:=private.pre_tipoff_input_fingerprint(v_today); END IF;
    IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
    PERFORM private.work_enqueue('pre-tipoff',v_window.tipoff_at::text||':'||v_fingerprint,p_now,
      jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'fingerprint',v_fingerprint));
  END LOOP;
END;
$$;
