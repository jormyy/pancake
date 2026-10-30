-- Canonical SQL source for public.notif_finish_web_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.notif_finish_web_atomic(p_id uuid, p_claim_token uuid, p_sent boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.notification_outbox SET web_delivered_at = CASE WHEN p_sent THEN clock_timestamp() ELSE web_delivered_at END,
    web_failed_at = CASE WHEN NOT p_sent THEN clock_timestamp() ELSE web_failed_at END
  WHERE id = p_id AND (web_attempt_claim_token = p_claim_token OR claim_token = p_claim_token) AND web_attempted_at IS NOT NULL;
  RETURN FOUND;
END;
$$;
