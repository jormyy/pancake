CREATE OR REPLACE FUNCTION public.invoke_player_injuries_if_due(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_last_tipoff timestamptz;
BEGIN
  SELECT max(game_time) INTO v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND status NOT IN ('Cancelled','Postponed');
  IF (p_now AT TIME ZONE 'America/New_York')::time < time '11:00' OR v_last_tipoff IS NULL OR p_now>v_last_tipoff THEN RETURN; END IF;
  IF private.claim_cron_dispatch('et:player-injuries',date_bin(interval '15 minutes',p_now,timestamptz '2000-01-01 00:00 UTC')::text) THEN
    PERFORM private.invoke_claimed_edge_function('et:player-injuries','sync-players','{"mode":"injuries"}'::jsonb);
  END IF;
END;
$$;
