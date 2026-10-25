-- Canonical SQL source for private.reconcile_edge_invocations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.reconcile_edge_invocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reconciled integer := 0;
  v_row record;
  v_claim record;
  v_error text;
  v_run uuid;
BEGIN
  FOR v_row IN
    WITH batch AS MATERIALIZED (
      SELECT inv.*
        FROM public.edge_invocations AS inv
       WHERE inv.reconciled_at IS NULL AND inv.queued_at < now() - interval '1 minute'
       ORDER BY inv.queued_at LIMIT 500 FOR UPDATE OF inv SKIP LOCKED
    )
    SELECT batch.*, resp.status_code AS response_status, resp.error_msg, resp.timed_out,
           left(resp.content, 500) AS content
      FROM batch
      LEFT JOIN net._http_response AS resp
        ON resp.id = batch.request_id
       AND resp.created >= (SELECT min(queued_at) FROM batch) - interval '1 minute'
     ORDER BY batch.queued_at
  LOOP
    v_error := CASE
      WHEN v_row.error_msg IS NOT NULL THEN v_row.error_msg
      WHEN v_row.timed_out IS TRUE THEN 'timed out'
      WHEN v_row.response_status NOT BETWEEN 200 AND 299
        THEN 'HTTP ' || v_row.response_status || ': ' || COALESCE(v_row.content, '')
      ELSE NULL END;
    UPDATE public.edge_invocations
       SET status_code = v_row.response_status, error_message = v_error
     WHERE id = v_row.id
       AND (status_code, error_message) IS DISTINCT FROM (v_row.response_status, v_error);

    IF v_row.worker_started_at IS NOT NULL THEN
      IF v_row.worker_finished_at IS NULL THEN
        IF v_row.worker_started_at >= now() - interval '10 minutes' THEN CONTINUE; END IF;
        UPDATE public.sync_runs SET status = 'failed', finished_at = now(),
          error = 'worker did not finish within 10 minutes' WHERE id = v_row.sync_run_id;
        UPDATE public.edge_invocations SET worker_status = 'failed' WHERE id = v_row.id;
      END IF;
    ELSIF v_row.function_name='sync-player-injuries' AND v_row.response_status=404 THEN
      NULL;
    ELSIF v_row.response_status BETWEEN 200 AND 299 AND v_error IS NULL THEN
      NULL;
    ELSE
      IF v_row.invocation_key IS NOT NULL AND v_row.queued_at >= now() - interval '10 minutes' THEN
        CONTINUE;
      END IF;
      IF v_error IS NULL THEN
        IF v_row.invocation_key IS NULL AND v_row.queued_at >= now() - interval '2 hours' THEN CONTINUE; END IF;
        v_error := CASE WHEN v_row.invocation_key IS NULL THEN
          'no response recorded within 2 hours (request never sent or pg_net purged it)'
          ELSE 'no worker or response recorded within 10 minutes' END;
      END IF;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed', v_error)
      RETURNING id INTO v_run;
      UPDATE public.edge_invocations SET sync_run_id = v_run, error_message = v_error WHERE id = v_row.id;
    END IF;
    UPDATE public.edge_invocations SET reconciled_at = now() WHERE id = v_row.id;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  FOR v_claim IN
    SELECT * FROM public.cron_dispatch_state WHERE attempts < 3 FOR UPDATE SKIP LOCKED
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
       AND reconciled_at IS NULL
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
         AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
         AND NOT (function_name='sync-player-injuries' AND status_code IS NOT DISTINCT FROM 404 AND worker_status IS NULL)
         AND (worker_status = 'failed' OR (worker_status IS NULL
           AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299)))
      ) THEN
        UPDATE public.cron_dispatch_state SET retry_after = clock_timestamp() + interval '5 minutes'
         WHERE job_key = v_claim.job_key AND retry_after IS NULL;
      ELSE
        UPDATE public.cron_dispatch_state SET retry_after = NULL
         WHERE job_key = v_claim.job_key AND retry_after IS NOT NULL;
      END IF;
    END IF;
  END LOOP;
  RETURN v_reconciled;
END;
$$;
