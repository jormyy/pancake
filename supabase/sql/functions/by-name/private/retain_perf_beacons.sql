CREATE OR REPLACE FUNCTION private.retain_perf_beacons(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_partitions bigint;
BEGIN
  v_partitions:=private.drop_expired_log_partitions('public.perf_beacons'::regclass,p_now-interval '30 days',p_now);
  WITH victims AS (
    SELECT r.id FROM public.perf_beacons r WHERE r.received_at<p_now-interval '30 days'
    ORDER BY r.received_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.perf_beacons r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.perf_beacons',v_count+v_partitions);
END;
$$;
