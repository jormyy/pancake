CREATE OR REPLACE FUNCTION public.notif_begin_web_atomic(p_id uuid, p_claim_token uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.notification_outbox%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.notification_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.claim_token IS DISTINCT FROM p_claim_token OR r.delivered_at IS NOT NULL
    OR r.suppressed_at IS NOT NULL OR r.dead_lettered_at IS NOT NULL THEN RETURN 'lost'; END IF;
  IF r.web_delivered_at IS NOT NULL THEN RETURN 'delivered'; END IF;
  IF r.web_attempted_at IS NOT NULL THEN RETURN 'attempted'; END IF;
  UPDATE public.notification_outbox SET web_attempted_at = now(), web_attempt_claim_token = p_claim_token WHERE id = p_id;
  RETURN 'send';
END;
$$;
