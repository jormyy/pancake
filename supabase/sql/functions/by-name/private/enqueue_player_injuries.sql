-- Canonical SQL source for private.enqueue_player_injuries.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_player_injuries(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date;
  v_first_tipoff timestamptz; v_last_tipoff timestamptz; v_key text;
BEGIN
  SELECT min(game_time),max(game_time) INTO v_first_tipoff,v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND status NOT IN ('Cancelled','Postponed');
  IF v_first_tipoff IS NULL THEN
    IF (p_now AT TIME ZONE 'America/New_York')::time<time '08:00' THEN RETURN; END IF;
    v_key:=v_today::text;
  ELSIF p_now BETWEEN v_first_tipoff-interval '2 hours' AND v_last_tipoff THEN
    v_key:=date_bin(interval '15 minutes',p_now,timestamptz '2000-01-01 00:00 UTC')::text;
  ELSIF p_now<v_first_tipoff-interval '2 hours' THEN
    v_key:=date_trunc('hour',p_now)::text;
  ELSE RETURN;
  END IF;
  PERFORM private.work_enqueue('player-injuries',v_key,p_now);
END;
$$;
