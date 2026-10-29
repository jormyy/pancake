CREATE OR REPLACE FUNCTION private.retain_league_events(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE removed bigint; dropped bigint;
BEGIN
  dropped:=private.drop_expired_log_partitions('public.league_events',p_now-interval '2 years',p_now);
  WITH victims AS (
    SELECT id FROM public.league_events WHERE created_at<p_now-interval '2 years'
    ORDER BY created_at,id LIMIT 5000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.league_events row USING victims WHERE row.id=victims.id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN jsonb_build_object('public.league_events',removed+dropped);
END;
$$;
