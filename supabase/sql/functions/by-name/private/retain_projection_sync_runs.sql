CREATE OR REPLACE FUNCTION private.retain_projection_sync_runs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_ids uuid[]; v_counts jsonb;
BEGIN
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.projection_sync_runs
    WHERE projection_period_end<date_trunc('week',timezone('America/Los_Angeles',p_now))::date
    ORDER BY projection_period_end,id LIMIT 200
  ) expired;
  v_counts:=private.delete_projection_runs(v_ids,10000);
  RETURN jsonb_build_object('public.projection_sync_runs',COALESCE((v_counts->>'projection_sync_runs')::bigint,0),
    'public.fantasypros_projection_rows',COALESCE((v_counts->>'fantasypros_projection_rows')::bigint,0));
END;
$$;
