SET lock_timeout = '5s';
SET statement_timeout = '2min';

ALTER TABLE public.notification_outbox
  ADD COLUMN expo_ticket_id text,
  ADD COLUMN push_token text,
  ADD COLUMN ticketed_at timestamptz,
  ADD COLUMN receipt_attempt_count int NOT NULL DEFAULT 0,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT notification_outbox_ticket_id_length
    CHECK (expo_ticket_id IS NULL OR octet_length(expo_ticket_id) <= 200) NOT VALID,
  ADD CONSTRAINT notification_outbox_push_token_length
    CHECK (push_token IS NULL OR octet_length(push_token) <= 512) NOT VALID,
  ADD CONSTRAINT notification_outbox_ticket_state
    CHECK (
      (expo_ticket_id IS NULL AND push_token IS NULL AND ticketed_at IS NULL)
      OR (expo_ticket_id IS NOT NULL AND push_token IS NOT NULL AND ticketed_at IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT notification_outbox_receipt_attempt_nonnegative
    CHECK (receipt_attempt_count >= 0) NOT VALID,
  ADD CONSTRAINT notification_outbox_terminal_state
    CHECK (delivered_at IS NULL OR dead_lettered_at IS NULL) NOT VALID;

ALTER TABLE public.notification_outbox
  VALIDATE CONSTRAINT notification_outbox_ticket_id_length,
  VALIDATE CONSTRAINT notification_outbox_push_token_length,
  VALIDATE CONSTRAINT notification_outbox_ticket_state,
  VALIDATE CONSTRAINT notification_outbox_receipt_attempt_nonnegative,
  VALIDATE CONSTRAINT notification_outbox_terminal_state;

DROP INDEX IF EXISTS public.notification_outbox_delivery_queue;
CREATE INDEX notification_outbox_delivery_queue
  ON public.notification_outbox (available_at, created_at, id)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND expo_ticket_id IS NULL;
CREATE INDEX notification_outbox_receipt_queue
  ON public.notification_outbox (available_at, ticketed_at, id)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND expo_ticket_id IS NOT NULL;
CREATE UNIQUE INDEX notification_outbox_expo_ticket_unique
  ON public.notification_outbox (expo_ticket_id)
  WHERE expo_ticket_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.enqueue_trade_status_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_type text;
  v_title text;
  v_body text;
BEGIN
  IF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'completed'::public.trade_status THEN
    v_event_type := 'trade_completed';
    v_title := 'Trade Completed';
    v_body := 'Assets have moved. Check your roster.';
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'expired'::public.trade_status THEN
    v_event_type := 'trade_expired';
    v_title := 'Trade Expired';
    v_body := 'One of your pending trade offers expired.';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notification_outbox (
    dedupe_key,
    member_id,
    event_type,
    title,
    body,
    data,
    category
  )
  SELECT
    format('%s:%s:%s', v_event_type, NEW.id, recipient.member_id),
    recipient.member_id,
    v_event_type,
    v_title,
    v_body,
    jsonb_build_object('tradeId', NEW.id),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.id
    UNION
    SELECT NEW.proposer_member_id
    UNION
    SELECT NEW.recipient_member_id
  ) AS recipient
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_trade_status_notification ON public.trades;
CREATE TRIGGER enqueue_trade_status_notification
  AFTER UPDATE OF status ON public.trades
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.enqueue_trade_status_notification();

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_atomic(
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  title text,
  body text,
  data jsonb,
  category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 200);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.expo_ticket_id IS NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.created_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id, queued.title,
       queued.body, queued.data, queued.category
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id, claimed.title,
    claimed.body, claimed.data, claimed.category
  FROM claimed;
END;
$$;

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
     WHERE queued.delivered_at IS NULL
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

REVOKE ALL ON FUNCTION private.enqueue_trade_status_notification() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_notification_outbox_atomic(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_atomic(int, int) TO service_role;
REVOKE ALL ON FUNCTION public.record_notification_outbox_ticket_atomic(uuid, uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_notification_outbox_ticket_atomic(uuid, uuid, text, text, int) TO service_role;
REVOKE ALL ON FUNCTION public.claim_notification_receipts_atomic(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_receipts_atomic(int, int) TO service_role;
REVOKE ALL ON FUNCTION public.complete_notification_outbox_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_notification_outbox_atomic(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fail_notification_outbox_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_notification_outbox_atomic(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.defer_notification_receipt_atomic(uuid, uuid, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_notification_receipt_atomic(uuid, uuid, text, int) TO service_role;
REVOKE ALL ON FUNCTION public.dead_letter_notification_outbox_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dead_letter_notification_outbox_atomic(uuid, uuid, text) TO service_role;

RESET statement_timeout;
RESET lock_timeout;
