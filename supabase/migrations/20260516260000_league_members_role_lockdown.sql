-- ============================================================
-- Migration: Lock down league_members.role escalation
--
-- SECURITY FIX (CRITICAL):
--   The existing UPDATE policy on league_members (migration 000004)
--   uses USING (auth.uid() = user_id) with NO WITH CHECK clause.
--   This lets ANY authenticated member run:
--     supabase.from('league_members')
--       .update({ role: 'commissioner' })
--       .eq('id', myMemberId)
--   The post-update row still satisfies USING, so it succeeds —
--   instantly granting full commissioner powers (advance season,
--   scoring edits, slot edits, league config, etc.) via
--   private.is_commissioner() and backend requireCommissioner().
--
-- Strategy:
--   A BEFORE UPDATE OF role trigger is additive and does not touch
--   the existing UPDATE policy (which is still needed for legitimate
--   self-updates like team_name). The trigger raises if a member
--   tries to change their own role (or anyone else's) without
--   already being a commissioner/co_commissioner of that league.
--
--   This is more robust than splitting RLS policies because:
--     • PG RLS has no OLD/NEW reference in policy expressions.
--     • Triggers run regardless of which RLS path the update took.
--     • The check is centralised — service_role updates also pass
--       through it, but service_role typically uses explicit RPCs
--       that set session_user to a commissioner (so no false block).
--
-- Service-role / backend note:
--   The backend uses the service_role key which bypasses RLS but
--   STILL fires triggers. In service-role context, auth.uid() is
--   NULL, so private.is_commissioner() returns false. To avoid
--   blocking legitimate backend role changes, we permit the change
--   when there is no authenticated end-user (auth.uid() IS NULL) —
--   the service role is trusted by definition. End-user updates
--   via PostgREST always have auth.uid() set, so this only opens
--   the gate for the trusted backend path.
-- ============================================================

CREATE OR REPLACE FUNCTION private.prevent_self_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  -- Only act if role actually changed (BEFORE UPDATE OF role is a hint;
  -- this guard is the authoritative check).
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    v_caller := (SELECT auth.uid());

    -- Service role / internal callers have no auth.uid() — trust them.
    -- All end-user calls via PostgREST have a non-null auth.uid().
    IF v_caller IS NOT NULL THEN
      IF NOT private.is_commissioner(NEW.league_id) THEN
        RAISE EXCEPTION
          'Only commissioners can change league member roles.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Idempotent re-installation.
DROP TRIGGER IF EXISTS prevent_self_role_escalation ON public.league_members;

CREATE TRIGGER prevent_self_role_escalation
  BEFORE UPDATE OF role ON public.league_members
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_self_role_escalation();

COMMENT ON FUNCTION private.prevent_self_role_escalation() IS
  'Prevents non-commissioner authenticated users from changing league_members.role. '
  'Closes a critical privilege escalation gap in the league_members UPDATE RLS policy.';
