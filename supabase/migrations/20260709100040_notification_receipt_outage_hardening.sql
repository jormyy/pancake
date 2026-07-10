SET lock_timeout = '5s';
SET statement_timeout = '2min';

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
     AND expo_ticket_id IS NOT NULL;
  RETURN FOUND;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.complete_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET delivered_at = now(),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dead_letter_notification_outbox_atomic(
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
     SET dead_lettered_at = now(),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Permanent notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.defer_notification_receipt_state_atomic(uuid, uuid, text, int, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_notification_receipt_state_atomic(uuid, uuid, text, int, boolean)
  TO service_role;
REVOKE ALL ON FUNCTION public.handle_new_auth_user()
  FROM PUBLIC, anon, authenticated, service_role;

RESET statement_timeout;
RESET lock_timeout;
