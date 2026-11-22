-- Canonical SQL source for private.activate_league_roster_policy.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.activate_league_roster_policy(p_league_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated int;
BEGIN
  UPDATE private.league_roster_policies
     SET floor_activated_at = COALESCE(floor_activated_at, now()),
         ir_activated_at = COALESCE(ir_activated_at, now())
   WHERE league_id = p_league_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
