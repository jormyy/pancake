ALTER TABLE public.notification_outbox ADD COLUMN web_attempt_claim_token uuid;
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
CREATE OR REPLACE FUNCTION public.notif_finish_web_atomic(p_id uuid, p_claim_token uuid, p_sent boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.notification_outbox SET web_delivered_at = CASE WHEN p_sent THEN now() ELSE web_delivered_at END,
    web_failed_at = CASE WHEN NOT p_sent THEN now() ELSE web_failed_at END
  WHERE id = p_id AND (web_attempt_claim_token = p_claim_token OR claim_token = p_claim_token) AND web_attempted_at IS NOT NULL;
  RETURN FOUND;
END;
$$;
