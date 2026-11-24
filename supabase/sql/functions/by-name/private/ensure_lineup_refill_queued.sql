-- Canonical SQL source for private.ensure_lineup_refill_queued.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.ensure_lineup_refill_queued()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM private.lineup_refill_requests
     WHERE claimed_at IS NULL OR claimed_at < clock_timestamp() - interval '10 minutes'
  ) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM private.work_items WHERE kind = 'lineup-refill' AND status IN ('pending', 'failed')) THEN
    RETURN;
  END IF;
  PERFORM private.work_enqueue('lineup-refill', gen_random_uuid()::text, now() + interval '15 seconds',
    jsonb_build_object('mode', 'roster_refill', 'queuedAt', clock_timestamp()));
END;
$$;
