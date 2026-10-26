CREATE OR REPLACE FUNCTION public.invoke_player_injuries_if_due(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_last_tipoff timestamptz;
  v_local time:=(p_now AT TIME ZONE 'America/New_York')::time; v_interval interval;
BEGIN
  SELECT max(game_time) INTO v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND status NOT IN ('Cancelled','Postponed');
  IF v_local>=time '11:00' AND p_now<=v_last_tipoff THEN v_interval:=interval '15 minutes';
  ELSIF v_local>=time '08:00' OR v_local<time '03:00' THEN v_interval:=interval '1 hour';
  ELSE RETURN; END IF;
  IF private.claim_cron_dispatch('et:player-injuries',date_bin(v_interval,p_now,timestamptz '2000-01-01 00:00 UTC')::text) THEN
    PERFORM private.invoke_claimed_edge_function('et:player-injuries','sync-player-injuries','{}'::jsonb);
  END IF;
END;
$$;
