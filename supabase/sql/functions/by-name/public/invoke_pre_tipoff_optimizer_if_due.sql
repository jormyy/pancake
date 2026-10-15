CREATE OR REPLACE FUNCTION public.invoke_pre_tipoff_optimizer_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window record;
  v_token uuid;
  v_fingerprint text;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  FOR v_window IN
    SELECT tipoff_at FROM (
    SELECT DISTINCT g.game_time AS tipoff_at
      FROM public.nba_games g
     WHERE g.game_date = v_today
       AND g.status = 'Scheduled'
       AND private.lineup_game_available(g.status, g.game_status_text)
       AND g.game_time > now()
       AND g.game_time <= now() + interval '2 minutes'
       AND g.started_at IS NULL
       AND EXISTS (
         SELECT 1 FROM public.lineup_optimizer_settings s
         JOIN public.league_seasons ls ON ls.id = s.league_season_id
         JOIN public.leagues l ON l.id = s.league_id
         WHERE s.enabled AND ls.is_current AND ls.season_year = g.season_year
           AND l.status IN ('active', 'playoffs')
       )
    UNION
    SELECT d.tipoff_at FROM public.lineup_tipoff_dispatches d
    WHERE d.game_date = v_today AND d.tipoff_at > now() - interval '1 minute'
      AND d.tipoff_at <= now() + interval '2 minutes'
    ) windows ORDER BY tipoff_at
  LOOP
    IF v_fingerprint IS NULL THEN
      v_fingerprint := private.pre_tipoff_input_fingerprint(v_today);
    END IF;
    v_token := NULL;
    INSERT INTO public.lineup_tipoff_dispatches (tipoff_at, game_date)
    VALUES (v_window.tipoff_at, v_today)
    ON CONFLICT (tipoff_at) DO NOTHING;

    UPDATE public.lineup_tipoff_dispatches
       SET status = 'queued', token = gen_random_uuid(), attempts = attempts + 1,
           lease_until = now() + interval '45 seconds', error = NULL,
           input_revision = input_revision + (input_fingerprint IS DISTINCT FROM v_fingerprint)::int,
           input_fingerprint = v_fingerprint
     WHERE tipoff_at = v_window.tipoff_at
       AND (status = 'pending' OR status = 'failed'
         OR (status IN ('queued', 'running') AND lease_until <= now())
         OR (status = 'succeeded' AND input_fingerprint IS DISTINCT FROM v_fingerprint))
    RETURNING token INTO v_token;

    IF v_token IS NOT NULL THEN
      BEGIN
        PERFORM public.invoke_edge_function('lineup-optimizer', jsonb_build_object(
          'mode', 'pre_tipoff', 'tipoffAt', v_window.tipoff_at, 'token', v_token
        ));
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.lineup_tipoff_dispatches SET status = 'failed', error = SQLERRM
         WHERE tipoff_at = v_window.tipoff_at AND token = v_token;
      END;
    END IF;
  END LOOP;
END;
$$;
