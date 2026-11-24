-- Canonical SQL source for public.complete_lineup_refill.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.complete_lineup_refill(p_member_id uuid, p_requested_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM private.lineup_refill_requests
   WHERE member_id = p_member_id AND requested_at = p_requested_at;
  UPDATE private.lineup_refill_requests SET claimed_at = NULL
   WHERE member_id = p_member_id AND requested_at <> p_requested_at;
  PERFORM private.ensure_lineup_refill_queued();
END;
$$;
