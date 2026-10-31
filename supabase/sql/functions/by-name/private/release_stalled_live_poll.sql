-- Canonical SQL source for private.release_stalled_live_poll.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.release_stalled_live_poll()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row record; v_count integer:=0;
BEGIN
  FOR v_row IN
    SELECT item.id,item.lease_token,inv.worker_started_at
    FROM private.work_items item
    JOIN public.edge_invocations inv ON inv.invocation_key=item.invocation_key AND inv.work_lease_token=item.lease_token
    WHERE item.kind='live-poll' AND item.status='running' AND item.lease_until>clock_timestamp()
      AND inv.worker_finished_at IS NULL
      AND CASE WHEN inv.worker_started_at IS NULL THEN
        inv.queued_at<=clock_timestamp()-interval '2 minutes' OR EXISTS(
          SELECT 1 FROM net._http_response resp
          WHERE resp.id=inv.request_id AND resp.created>=inv.queued_at-interval '1 minute'
            AND (resp.error_msg IS NOT NULL OR resp.timed_out IS TRUE OR resp.status_code NOT BETWEEN 200 AND 299))
      ELSE
        item.lease_until<=clock_timestamp()+interval '210 seconds'
        AND NOT EXISTS(SELECT 1 FROM public.live_poll_leases lease WHERE lease.lock_key=779001 AND lease.expires_at>clock_timestamp())
      END
    FOR UPDATE OF inv,item SKIP LOCKED
  LOOP
    IF private.work_finish(v_row.id,v_row.lease_token,CASE WHEN v_row.worker_started_at IS NULL
      THEN 'Worker never started' ELSE 'Worker stopped renewing its lease' END) THEN
      UPDATE private.work_items SET due_at=now() WHERE id=v_row.id AND status='failed';
      v_count:=v_count+1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
