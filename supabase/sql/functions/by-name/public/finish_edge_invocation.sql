CREATE OR REPLACE FUNCTION public.finish_edge_invocation(
  p_invocation_key uuid,
  p_status text,
  p_rows_affected integer DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.edge_invocations%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'Invalid worker outcome';
  END IF;
  SELECT * INTO v_inv FROM public.edge_invocations WHERE invocation_key = p_invocation_key FOR UPDATE;
  IF NOT FOUND OR v_inv.worker_started_at IS NULL THEN RAISE EXCEPTION 'Invocation has no worker'; END IF;
  IF v_inv.worker_finished_at IS NOT NULL THEN RETURN; END IF;
  IF v_inv.work_item_id IS NOT NULL AND NOT private.work_finish(v_inv.work_item_id,v_inv.work_lease_token,CASE WHEN p_status='failed' THEN coalesce(p_error,'Worker failed') END) THEN
    RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409';
  END IF;
  UPDATE public.sync_runs
     SET status = p_status, rows_affected = p_rows_affected, error = left(p_error, 4000),
         finished_at = clock_timestamp()
   WHERE id = v_inv.sync_run_id;
  UPDATE public.edge_invocations
     SET worker_status = p_status, worker_finished_at = clock_timestamp(), reconciled_at = NULL
   WHERE id = v_inv.id;
END;
$$;
