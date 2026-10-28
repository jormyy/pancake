CREATE OR REPLACE FUNCTION private.prune_perf_beacons()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '100ms'
SET statement_timeout = '3s'
AS $$
DECLARE
  removed bigint;
BEGIN
  removed := (private.retain_perf_beacons()->>'public.perf_beacons')::bigint;
  RETURN removed;
END;
$$;
