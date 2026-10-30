-- Canonical SQL source for private.enqueue_player_injuries.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_player_injuries(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_last_tipoff timestamptz;
  v_local time:=(p_now AT TIME ZONE 'America/New_York')::time; v_interval interval;
BEGIN
  SELECT max(game_time) INTO v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND status NOT IN ('Cancelled','Postponed');
  IF v_local>=time '11:00' AND p_now<=v_last_tipoff THEN v_interval:=interval '15 minutes';
  ELSIF v_local>=time '08:00' OR v_local<time '03:00' THEN v_interval:=interval '1 hour';
  ELSE RETURN; END IF;
  PERFORM private.work_enqueue('player-injuries',date_bin(v_interval,p_now,timestamptz '2000-01-01 00:00 UTC')::text,p_now);
END;
$$;
