-- ============================================================
-- Migration: Revoke default PUBLIC EXECUTE on the two
--            user-facing league-lifecycle SECURITY DEFINER
--            RPCs; re-grant EXECUTE to authenticated +
--            service_role only.
--
-- SECURITY FIX (Slice A — iter 30):
--   Iter 29's REVOKE pass
--   (20260516310000_revoke_definer_function_grants.sql) closed
--   the default PUBLIC EXECUTE grant on four admin-only
--   SECURITY DEFINER functions but missed two more in the same
--   public schema:
--
--     1. public.create_league(text, text, int)
--        Most recently redefined in migrations
--          20260427000001_rpc_create_league.sql,
--          20260512000008_dynamic_league_lifecycle_rpcs.sql,
--          20260512000011_seed_league_waiver_priorities.sql.
--        SECURITY DEFINER; creates a league row, seeds the
--        first league_member as commissioner, allocates an
--        invite code, and seeds the initial draft pick set.
--
--     2. public.join_league_by_invite_code(text, text)
--        Most recently redefined in migrations
--          20260328000003_rpc_join_league.sql,
--          20260424000002_fix_draft_picks_on_join.sql,
--          20260512000008_dynamic_league_lifecycle_rpcs.sql,
--          20260512000011_seed_league_waiver_priorities.sql.
--        SECURITY DEFINER; resolves an invite code to a
--        league, attaches the caller as a manager-role
--        league_member, and seeds their forward draft picks.
--
--   Both check `auth.uid()` internally and abort with
--   'Not authenticated' when the caller is the anon role, so
--   immediate abuse is bounded. They are still inconsistent
--   with the iter-29 invariant: every SECURITY DEFINER
--   function in this repo should have its default PUBLIC
--   EXECUTE explicitly REVOKEd and EXECUTE re-granted only to
--   the roles that need it.
--
--   Unlike the four functions locked down in iter 29, these
--   two are intended to be invoked by authenticated end-users
--   via PostgREST RPC (the league-create flow on the frontend
--   and the join-by-invite-code flow). The 'authenticated'
--   GRANT below preserves that path. 'anon' is dropped to
--   match the rest of the lockdown surface — the internal
--   auth.uid() check already returns NULL for anon callers,
--   so this is defense-in-depth, not a behavioral change.
--   'service_role' retains EXECUTE for backend admin paths
--   and tests.
--
-- Backend impact:
--   • Frontend (Expo / Supabase JS) calls these as the
--     authenticated user via PostgREST RPC — preserved by the
--     'authenticated' GRANT.
--   • Backend service-role helpers and E2E harness call them
--     via the service-role client — preserved by the
--     'service_role' GRANT.
--   • No anon-role call path exists for either function — the
--     internal auth.uid() check already rejects them.
--
-- Idempotency:
--   REVOKE and GRANT are naturally idempotent. Re-running this
--   migration on an already-locked database is a no-op.
--
-- Rollback (NOT recommended — reintroduces the default
-- PUBLIC EXECUTE inconsistency):
--   GRANT EXECUTE ON FUNCTION public.create_league(text, text, int) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text) TO PUBLIC;
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. create_league(text, text, int)
-- ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_league(text, text, int)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_league(text, text, int)
  TO authenticated, service_role;


-- ────────────────────────────────────────────────────────────────────────
-- 2. join_league_by_invite_code(text, text)
-- ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.join_league_by_invite_code(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text)
  TO authenticated, service_role;
