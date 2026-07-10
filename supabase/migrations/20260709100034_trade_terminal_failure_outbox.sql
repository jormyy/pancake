SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE TABLE public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  category text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  attempt_count int NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_outbox_dedupe_key_length CHECK (octet_length(dedupe_key) <= 500),
  CONSTRAINT notification_outbox_event_type_length CHECK (octet_length(event_type) <= 100),
  CONSTRAINT notification_outbox_title_length CHECK (octet_length(title) <= 500),
  CONSTRAINT notification_outbox_body_length CHECK (octet_length(body) <= 4000),
  CONSTRAINT notification_outbox_category_known CHECK (category IN ('trade', 'waiver', 'draft', 'activity')),
  CONSTRAINT notification_outbox_attempt_count_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT notification_outbox_claim_pair CHECK ((claimed_at IS NULL) = (claim_token IS NULL))
);

ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

CREATE INDEX notification_outbox_delivery_queue
  ON public.notification_outbox (available_at, created_at, id)
  WHERE delivered_at IS NULL;

REVOKE ALL ON TABLE public.notification_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.expire_trade_completion_failure_atomic(
  p_trade_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_rows int;
  v_league_status text;
  v_is_current boolean;
  v_reason text := COALESCE(NULLIF(BTRIM(p_reason), ''), 'The accepted trade could not be completed.');
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'accepted'
     AND veto_window_expires_at <= now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade is not an expired accepted trade';
  END IF;

  SELECT status
    INTO v_league_status
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT is_current
    INTO v_is_current
    FROM league_seasons
   WHERE id = v_trade.league_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade season not found.';
  END IF;

  IF v_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Trades require the current season.';
  END IF;

  IF v_league_status = 'archived' THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  UPDATE trades
     SET status = 'expired',
         completed_at = NULL,
         completion_failure_reason = v_reason
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to expire accepted trade';
  END IF;

  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_trade_id,
    event_type,
    title,
    body,
    metadata
  )
  VALUES (
    v_trade.league_id,
    v_trade.league_season_id,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    v_trade.id,
    'trade_completion_failed',
    'Accepted trade expired',
    v_reason,
    jsonb_build_object('reason', v_reason, 'terminal', true)
  );

  INSERT INTO notification_outbox (
    dedupe_key,
    member_id,
    event_type,
    title,
    body,
    data,
    category
  )
  SELECT
    format('trade_terminal_failure:%s:%s', v_trade.id, recipient.member_id),
    recipient.member_id,
    'trade_completion_failed',
    'Accepted Trade Expired',
    'An accepted trade could not be completed. Check the trade activity for details.',
    jsonb_build_object('tradeId', v_trade.id, 'reason', v_reason),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = v_trade.id
    UNION
    SELECT v_trade.proposer_member_id
    UNION
    SELECT v_trade.recipient_member_id
  ) AS recipient
  ON CONFLICT (dedupe_key) DO NOTHING;
END;
$$;

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
     AND delivered_at IS NULL;
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
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Unknown notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND delivered_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_trade_completion_failure_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_trade_completion_failure_atomic(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.claim_notification_outbox_atomic(int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_atomic(int, int) TO service_role;
REVOKE ALL ON FUNCTION public.complete_notification_outbox_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_notification_outbox_atomic(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fail_notification_outbox_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_notification_outbox_atomic(uuid, uuid, text) TO service_role;

RESET statement_timeout;
RESET lock_timeout;
