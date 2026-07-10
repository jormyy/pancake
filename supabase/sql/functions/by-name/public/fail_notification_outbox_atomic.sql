-- Canonical SQL source for public.fail_notification_outbox_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.fail_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET attempt_count = attempt_count + 1,
         available_at = now() + make_interval(
           secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)
         ),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         receipt_attempt_count = 0,
         dead_lettered_at = CASE WHEN attempt_count + 1 >= 12 THEN now() ELSE NULL END,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Unknown notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;
