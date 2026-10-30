-- Canonical SQL source for public.notif_suppress_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.notif_suppress_atomic(p_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.notification_outbox SET suppressed_at = now(), suppression_reason = 'preferences_disabled',
    claimed_at = NULL, claim_token = NULL
  WHERE id = p_id AND claim_token = p_claim_token AND delivered_at IS NULL AND suppressed_at IS NULL
    AND dead_lettered_at IS NULL AND expo_ticket_id IS NULL;
  RETURN FOUND;
END;
$$;
