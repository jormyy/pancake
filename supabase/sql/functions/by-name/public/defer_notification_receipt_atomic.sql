-- Canonical SQL source for public.defer_notification_receipt_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.defer_notification_receipt_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text,
  p_retry_delay_seconds int DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delay int := LEAST(GREATEST(COALESCE(p_retry_delay_seconds, 60), 15), 3600);
BEGIN
  UPDATE notification_outbox
     SET receipt_attempt_count = receipt_attempt_count + 1,
         available_at = now() + make_interval(secs => v_delay),
         dead_lettered_at = CASE
           WHEN receipt_attempt_count + 1 >= 12 OR ticketed_at <= now() - interval '23 hours' THEN now()
           ELSE NULL
         END,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Expo receipt is not available'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL
     AND expo_ticket_id IS NOT NULL;
  RETURN FOUND;
END;
$$;
