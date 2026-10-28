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
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.cancel_waiver_claim_atomic', jsonb_build_array(p_claim_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_status waiver_claim_status;
  v_rows int;
  v_process_date date;
BEGIN
  SELECT claim.status, claim.process_date
    INTO v_status, v_process_date
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

  IF (v_process_date + time '00:00') AT TIME ZONE coalesce((SELECT league.timezone FROM leagues league JOIN waiver_claims claim ON claim.league_id=league.id WHERE claim.id=p_claim_id), 'America/Los_Angeles') <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
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
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
