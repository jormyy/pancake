-- Canonical SQL source for private.league_auto_ir_all_members.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.league_auto_ir_all_members(p_league_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    (SELECT policy.auto_ir_all_members
       FROM private.league_roster_policies policy
      WHERE policy.league_id = p_league_id
        AND policy.ir_activated_at IS NOT NULL),
    false
  );
$function$;
