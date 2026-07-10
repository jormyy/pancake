-- Canonical SQL source for public.defer_notification_receipt_state_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.defer_notification_receipt_state_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text,
  p_retry_delay_seconds int DEFAULT 60,
  p_increment_attempt boolean DEFAULT true
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delay int := LEAST(GREATEST(COALESCE(p_retry_delay_seconds, 60), 15), 3600);
  v_state text;
BEGIN
  UPDATE notification_outbox
     SET receipt_attempt_count = receipt_attempt_count + CASE WHEN p_increment_attempt THEN 1 ELSE 0 END,
         available_at = now() + make_interval(secs => v_delay),
         dead_lettered_at = CASE
           WHEN ticketed_at <= now() - interval '23 hours' THEN now()
           ELSE NULL
         END,
         expo_ticket_id = CASE
           WHEN ticketed_at <= now() - interval '23 hours' THEN NULL
           ELSE expo_ticket_id
         END,
         push_token = CASE
           WHEN ticketed_at <= now() - interval '23 hours' THEN NULL
           ELSE push_token
         END,
         ticketed_at = CASE
           WHEN ticketed_at <= now() - interval '23 hours' THEN NULL
           ELSE ticketed_at
         END,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Expo receipt is not available'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL
     AND expo_ticket_id IS NOT NULL
  RETURNING CASE
    WHEN dead_lettered_at IS NULL THEN 'deferred'
    ELSE 'dead_lettered'
  END INTO v_state;

  RETURN v_state;
END;
$$;
