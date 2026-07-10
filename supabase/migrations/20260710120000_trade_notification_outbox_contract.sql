SET lock_timeout = '5s';
SET statement_timeout = '2min';

UPDATE public.notification_outbox
   SET data = jsonb_set(
         data,
         '{originalOutboxCategory}',
         to_jsonb(category),
         true
       ),
       category = 'trade',
       dead_lettered_at = COALESCE(dead_lettered_at, now()),
       expo_ticket_id = NULL,
       push_token = NULL,
       ticketed_at = NULL,
       claimed_at = NULL,
       claim_token = NULL,
       last_error = left(
         COALESCE(last_error || '; ', '') || 'Unsupported legacy notification outbox category',
         2000
       )
 WHERE category <> 'trade';

ALTER TABLE public.notification_outbox
  ADD CONSTRAINT notification_outbox_trade_category
  CHECK (category = 'trade') NOT VALID;

ALTER TABLE public.notification_outbox
  VALIDATE CONSTRAINT notification_outbox_trade_category;

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
     WHERE queued.category = 'trade'
       AND queued.delivered_at IS NULL
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

REVOKE ALL ON FUNCTION public.claim_notification_outbox_atomic(int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_atomic(int, int) TO service_role;

RESET statement_timeout;
RESET lock_timeout;
