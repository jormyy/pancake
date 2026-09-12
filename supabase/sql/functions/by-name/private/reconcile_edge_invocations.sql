-- Canonical SQL source for private.reconcile_edge_invocations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.reconcile_edge_invocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reconciled integer := 0;
  v_row record;
BEGIN
  -- pg_net writes net._http_response asynchronously and purges it after a few
  -- hours, so responses are copied onto the durable edge_invocations row.
  -- A non-2xx status, a transport error, or no response at all within the
  -- grace window becomes a failed sync_runs row: the documented health surface
  -- previously showed nothing when the function never booted.
  FOR v_row IN
    SELECT inv.id, inv.function_name, inv.request_id, inv.queued_at,
           resp.status_code, resp.error_msg, resp.timed_out, left(resp.content, 500) AS content
      FROM public.edge_invocations AS inv
      LEFT JOIN net._http_response AS resp ON resp.id = inv.request_id
     WHERE inv.reconciled_at IS NULL
       AND inv.queued_at < now() - interval '1 minute'
     ORDER BY inv.queued_at
     LIMIT 500
     FOR UPDATE OF inv SKIP LOCKED
  LOOP
    IF v_row.status_code IS NULL AND v_row.error_msg IS NULL AND v_row.timed_out IS NOT TRUE THEN
      -- Nothing recorded yet. Wait up to the grace window, then fail closed.
      IF v_row.queued_at >= now() - interval '2 hours' THEN
        CONTINUE;
      END IF;
      UPDATE public.edge_invocations
         SET error_message = 'no response recorded within 2 hours (request never sent or pg_net purged it)',
             reconciled_at = now()
       WHERE id = v_row.id;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed',
              'no response recorded within 2 hours (request never sent or pg_net purged it)');
    ELSIF v_row.error_msg IS NOT NULL OR v_row.timed_out IS TRUE OR v_row.status_code >= 400 THEN
      UPDATE public.edge_invocations
         SET status_code = v_row.status_code,
             error_message = COALESCE(v_row.error_msg, CASE WHEN v_row.timed_out THEN 'timed out' END, 'HTTP ' || v_row.status_code || ': ' || COALESCE(v_row.content, '')),
             reconciled_at = now()
       WHERE id = v_row.id;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed',
              COALESCE(v_row.error_msg, CASE WHEN v_row.timed_out THEN 'timed out' END, 'HTTP ' || v_row.status_code || ': ' || COALESCE(v_row.content, '')));
    ELSE
      UPDATE public.edge_invocations
         SET status_code = v_row.status_code,
             reconciled_at = now()
       WHERE id = v_row.id;
    END IF;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  DELETE FROM public.edge_invocations
   WHERE reconciled_at < now() - interval '30 days';

  RETURN v_reconciled;
END;
$$;
