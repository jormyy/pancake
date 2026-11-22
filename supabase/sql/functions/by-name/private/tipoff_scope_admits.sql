-- Canonical SQL source for private.tipoff_scope_admits.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.tipoff_scope_admits(
  p_scope text,
  p_league_id uuid,
  p_lock boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active boolean;
BEGIN
  IF p_lock THEN
    SELECT (policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL)
      INTO v_active
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
     FOR SHARE;
  ELSE
    SELECT (policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL)
      INTO v_active
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id;
  END IF;
  v_active := COALESCE(v_active, false);
  IF p_scope = '' THEN
    RETURN NOT v_active;
  END IF;
  RETURN p_scope = p_league_id::text AND v_active;
END;
$$;
