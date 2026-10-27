CREATE OR REPLACE FUNCTION public.start_edge_invocation(
  p_invocation_key uuid,
  p_function_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.edge_invocations%ROWTYPE;
  v_run uuid;
BEGIN
  SELECT * INTO v_inv FROM public.edge_invocations
   WHERE invocation_key = p_invocation_key AND function_name = p_function_name
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown invocation for this function'; END IF;
  IF v_inv.worker_started_at IS NOT NULL OR v_inv.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invocation already started or settled';
  END IF;
  IF v_inv.queued_at < clock_timestamp() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Invocation expired before worker startup';
  END IF;
  IF v_inv.work_item_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM private.work_items WHERE id=v_inv.work_item_id AND lease_token=v_inv.work_lease_token AND invocation_key=p_invocation_key AND status='running' AND lease_until>now()
  ) THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.sync_runs (function_name, started_at)
  VALUES (p_function_name, clock_timestamp()) RETURNING id INTO v_run;
  UPDATE public.edge_invocations
     SET worker_started_at = clock_timestamp(), worker_status = 'running', sync_run_id = v_run
   WHERE id = v_inv.id;
  RETURN v_run;
END;
$$;
