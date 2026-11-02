CREATE OR REPLACE FUNCTION private.nightly_work_retry_at(p_now timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT CASE
    WHEN (p_now AT TIME ZONE 'America/New_York')::time>=time '04:00'
      AND (p_now AT TIME ZONE 'America/New_York')::time<time '06:00'
    THEN least(p_now+interval '1 minute',((p_now AT TIME ZONE 'America/New_York')::date+time '06:00') AT TIME ZONE 'America/New_York')
    ELSE (((p_now AT TIME ZONE 'America/New_York')::date
      +CASE WHEN (p_now AT TIME ZONE 'America/New_York')::time<time '04:00' THEN 0 ELSE 1 END
      +time '04:00') AT TIME ZONE 'America/New_York')
    END;
$$;
