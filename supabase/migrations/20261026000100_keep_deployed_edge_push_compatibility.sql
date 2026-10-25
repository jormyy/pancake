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
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL
     AND expo_ticket_id IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_notification_receipts_atomic(
  p_limit int DEFAULT 200,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  expo_ticket_id text,
  push_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 200), 0), 1000);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.suppressed_at IS NULL
       AND queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.expo_ticket_id IS NOT NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.ticketed_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id,
       queued.expo_ticket_id, queued.push_token
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id,
    claimed.expo_ticket_id, claimed.push_token
  FROM claimed;
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

CREATE OR REPLACE FUNCTION public.register_push_token_atomic(
  p_user_id uuid,
  p_token text,
  p_revocation_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  IF p_token IS NULL OR p_token = '' OR octet_length(p_token) > 512 THEN
    RAISE EXCEPTION 'Invalid push token.' USING ERRCODE = '22023';
  END IF;
  IF p_revocation_hash IS NULL OR p_revocation_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid push-token revocation hash.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('push-token'), hashtext(p_token));

  UPDATE profiles
     SET push_token = NULL,
         push_token_revocation_hash = NULL
   WHERE push_token = p_token
     AND id <> p_user_id;

  UPDATE profiles
     SET push_token = p_token,
         push_token_revocation_hash = p_revocation_hash
   WHERE id = p_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Profile not found.' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_push_token_atomic(
  p_token text,
  p_revocation_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_token IS NULL OR p_token = '' OR octet_length(p_token) > 512 OR
     p_revocation_hash IS NULL OR p_revocation_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('push-token'), hashtext(p_token));
  UPDATE profiles
     SET push_token = NULL,
         push_token_revocation_hash = NULL
   WHERE push_token = p_token
     AND push_token_revocation_hash = p_revocation_hash;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_push_token_for_user_atomic(
  p_user_id uuid,
  p_token text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('push-token'), hashtext(p_token));
  UPDATE profiles
     SET push_token = NULL,
         push_token_revocation_hash = NULL
   WHERE id = p_user_id
     AND push_token = p_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.record_notification_outbox_ticket_atomic(uuid, uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_notification_outbox_ticket_atomic(uuid, uuid, text, text, int) TO service_role;

REVOKE ALL ON FUNCTION public.claim_notification_receipts_atomic(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_receipts_atomic(int, int) TO service_role;

REVOKE ALL ON FUNCTION public.defer_notification_receipt_state_atomic(uuid, uuid, text, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_notification_receipt_state_atomic(uuid, uuid, text, int, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.register_push_token_atomic(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_token_atomic(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_push_token_atomic(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_push_token_atomic(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.clear_push_token_for_user_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_push_token_for_user_atomic(uuid, text) TO service_role;
