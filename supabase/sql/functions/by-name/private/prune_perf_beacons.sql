CREATE OR REPLACE FUNCTION private.prune_perf_beacons()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '250ms'
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM public.perf_beacons WHERE received_at < now() - interval '30 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
