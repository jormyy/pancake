CREATE OR REPLACE FUNCTION private.enqueue_daily(p_kind text,p_hour integer,p_minute integer DEFAULT 0,p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_local timestamp:=p_now AT TIME ZONE 'America/New_York';
BEGIN
  IF v_local::time>=make_time(p_hour,p_minute,0) THEN
    PERFORM private.work_enqueue(p_kind,v_local::date::text,p_now);
  END IF;
END;
$$;
