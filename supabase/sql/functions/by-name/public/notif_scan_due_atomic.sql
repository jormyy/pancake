-- Canonical SQL source for public.notif_scan_due_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.notif_scan_due_atomic(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF (NOT EXISTS(SELECT 1 FROM private.notification_scan_state WHERE id AND (available_at<=p_now OR scan_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM private.notification_scan_dirty))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('scheduler-chunk:notification-scan',0)) THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='notification-scan' AND status IN('pending','running','failed')) THEN
    UPDATE private.work_items SET payload=jsonb_build_object('schedulerChunk','notifications','at',p_now),due_at=LEAST(due_at,p_now)
      WHERE kind='notification-scan' AND status IN('pending','failed') AND payload->>'at' IS DISTINCT FROM to_jsonb(p_now)#>>'{}';
    RETURN;
  END IF;
  PERFORM private.work_enqueue('notification-scan',date_trunc('minute',p_now)::text,p_now,
    jsonb_build_object('schedulerChunk','notifications','at',p_now));
END;
$$;
