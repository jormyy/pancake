-- Canonical SQL source for public.cancel_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.cancel_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status waiver_claim_status;
  v_rows int;
BEGIN
  SELECT claim.status
    INTO v_status
    FROM waiver_claims AS claim
    JOIN league_members AS member
      ON member.id = claim.member_id
   WHERE claim.id = p_claim_id
     AND claim.member_id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE OF claim;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'pending'::waiver_claim_status THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE waiver_claims
     SET status = 'cancelled'::waiver_claim_status,
         processed_at = now()
   WHERE id = p_claim_id
     AND status = 'pending'::waiver_claim_status;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
