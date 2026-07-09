-- Canonical SQL source for public.prevent_season_deactivation_with_pending_waivers.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.prevent_season_deactivation_with_pending_waivers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM waiver_claims AS claim
   WHERE claim.league_id = OLD.league_id
     AND claim.league_season_id = OLD.id
     AND claim.status = 'pending'::waiver_claim_status
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Resolve pending waiver claims and waiver holds before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM waiver_wire_log AS log
   WHERE log.league_id = OLD.league_id
     AND log.league_season_id = OLD.id
     AND log.cleared_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Resolve pending waiver claims and waiver holds before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
