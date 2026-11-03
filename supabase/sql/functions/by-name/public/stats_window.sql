CREATE OR REPLACE FUNCTION public.stats_window(p_days integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE last_date date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF p_days IS NULL THEN RETURN NULL; END IF;
  IF p_days NOT IN (7, 15) THEN
    RAISE EXCEPTION 'Choose past 7 or 15 days.' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('days', p_days, 'startDate', last_date - (p_days - 1),
    'endDate', last_date, 'timeZone', 'America/New_York');
END;
$$;
