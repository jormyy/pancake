-- Canonical SQL source for public.record_notification_outbox_ticket_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.record_notification_outbox_ticket_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_expo_ticket_id text,
  p_push_token text,
  p_receipt_delay_seconds int DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delay int := LEAST(GREATEST(COALESCE(p_receipt_delay_seconds, 900), 0), 3600);
BEGIN
  IF p_expo_ticket_id IS NULL OR p_expo_ticket_id = '' OR octet_length(p_expo_ticket_id) > 200 OR
     p_push_token IS NULL OR p_push_token = '' OR octet_length(p_push_token) > 512 THEN
    RAISE EXCEPTION 'Invalid Expo ticket state.' USING ERRCODE = '22023';
  END IF;

  UPDATE notification_outbox
     SET expo_ticket_id = p_expo_ticket_id,
         push_token = p_push_token,
         ticketed_at = now(),
         receipt_attempt_count = 0,
         available_at = now() + make_interval(secs => v_delay),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL
     AND expo_ticket_id IS NULL;
  RETURN FOUND;
END;
$$;
