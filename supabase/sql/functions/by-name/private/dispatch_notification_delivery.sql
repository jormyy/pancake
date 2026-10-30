-- Canonical SQL source for private.dispatch_notification_delivery.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.dispatch_notification_delivery(p_now timestamptz,p_cycle bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item private.work_items%ROWTYPE;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.notification_outbox WHERE suppressed_at IS NULL AND delivered_at IS NULL
    AND dead_lettered_at IS NULL AND available_at<=p_now) THEN RETURN; END IF;
  PERFORM private.work_enqueue('process-trades','notification-scan:'||p_cycle,p_now,
    jsonb_build_object('notificationCycle',p_cycle));
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.work_claim',0)) THEN RETURN; END IF;
  WITH due AS (
    SELECT id FROM private.work_items WHERE kind='process-trades' AND status IN('pending','failed') AND due_at<=p_now
      AND (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<4
    ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE private.work_items stored SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
    FROM due WHERE stored.id=due.id RETURNING stored.* INTO item;
  IF FOUND THEN PERFORM private.work_execute(item.id,item.lease_token); END IF;
END;
$$;
