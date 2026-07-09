-- Canonical SQL source for public.edit_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_balance int;
  v_drop_failure text;
BEGIN
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_claim.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE waiver_claims
     SET drop_player_id = p_drop_player_id,
         bid_amount = v_bid_amount,
         claim_order = COALESCE(p_claim_order, claim_order),
         submitted_at = now()
   WHERE id = p_claim_id;
END;
$$;
