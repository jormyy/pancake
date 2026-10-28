CREATE OR REPLACE FUNCTION public.public_prune_read_log()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '1s' AS $$
DECLARE removed integer;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(9182, 17) THEN RETURN 0; END IF;
  WITH expired AS (
    SELECT ctid FROM public.public_read_log WHERE hour < date_trunc('hour', now()) - interval '7 days'
    ORDER BY hour LIMIT 10000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.public_read_log WHERE ctid IN (SELECT ctid FROM expired);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
