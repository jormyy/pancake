CREATE OR REPLACE FUNCTION private.next_waiver_run(p_clears_at timestamptz, p_submitted_at timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_day date := (greatest(p_clears_at, p_submitted_at) AT TIME ZONE 'America/New_York')::date;
  v_run timestamptz;
BEGIN
  v_run := (v_day + time '03:00') AT TIME ZONE 'America/New_York';
  IF v_run <= p_submitted_at OR v_run < p_clears_at THEN
    v_run := (v_day + 1 + time '03:00') AT TIME ZONE 'America/New_York';
  END IF;
  RETURN v_run;
END;
$$;
