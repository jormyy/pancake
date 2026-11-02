CREATE OR REPLACE FUNCTION private.trade_revaluation_next_change()
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT ((now() AT TIME ZONE 'America/New_York')::date
    +CASE WHEN (now() AT TIME ZONE 'America/New_York')::time<time '04:00' THEN 0 ELSE 1 END
    +time '04:00') AT TIME ZONE 'America/New_York';
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_next_change() FROM PUBLIC,anon,authenticated,service_role;
