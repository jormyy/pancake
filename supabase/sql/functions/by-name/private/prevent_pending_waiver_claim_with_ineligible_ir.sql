-- Canonical SQL source for private.prevent_pending_waiver_claim_with_ineligible_ir.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_claim_with_ineligible_ir()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
BEGIN
  IF NEW.status = 'pending'::waiver_claim_status THEN
    PERFORM private.assert_legal_roster(NEW.league_id,NEW.league_season_id,NEW.member_id);
  END IF;
  RETURN NEW;
END;
$$;
