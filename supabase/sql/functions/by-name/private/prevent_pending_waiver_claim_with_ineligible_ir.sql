-- Canonical SQL source for private.prevent_pending_waiver_claim_with_ineligible_ir.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_claim_with_ineligible_ir()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ineligible text;
BEGIN
  IF NEW.status = 'pending'::waiver_claim_status THEN
    v_ineligible := private.ineligible_ir_player_names(
      NEW.league_id,
      NEW.league_season_id,
      NEW.member_id
    );

    IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
      RAISE EXCEPTION 'You have ineligible players on IR (%). Activate or drop them before placing waiver claims.',
        v_ineligible
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
