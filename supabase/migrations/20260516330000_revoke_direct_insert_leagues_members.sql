-- ============================================================
-- Migration: Revoke direct authenticated/anon INSERT on
--   public.leagues and public.league_members
--
-- SECURITY FIX (CRITICAL):
--
-- ISSUE 1 — league_members manager-INSERT bypass
--   Migration 20260516280000_rls_escalation_lockdown.sql installed
--   a BEFORE INSERT trigger (private.prevent_insert_self_commissioner)
--   that blocks an authenticated client from inserting a row with
--   role='commissioner' or role='co_commissioner'. But the trigger
--   explicitly returns NEW for any other role with the comment
--   "manager is fine" — relying on the league_members_insert RLS
--   policy WITH CHECK (auth.uid() = user_id) as the only guard.
--
--   The problem: that WITH CHECK doesn't restrict the league_id.
--   Any authenticated user who knows (or guesses) a victim league's
--   UUID can run from the React Native client:
--
--     supabase.from('league_members').insert({
--       league_id: '<victim-league-uuid>',
--       user_id:   auth.uid(),
--       role:      'manager',
--       team_name: 'Squatter',
--     });
--
--   The row passes WITH CHECK (auth.uid() = user_id), the
--   prevent_insert_self_commissioner trigger short-circuits because
--   role NOT IN ('commissioner','co_commissioner'), and the attacker
--   is now a member of the victim league without an invite_code,
--   bypassing join_league_by_invite_code entirely. As a member they
--   immediately gain read access to roster data, draft state, and
--   league chat via every (league_id IN private.my_league_ids())
--   USING clause across the schema.
--
-- ISSUE 2 — leagues INSERT bypass with Prefer: return=minimal
--   The leagues_insert policy WITH CHECK (auth.uid() = commissioner_id)
--   was paired with leagues_select (id IN private.my_league_ids()),
--   on the assumption that PostgREST RETURNING would fail (the new
--   row isn't visible to my_league_ids() yet) and the whole INSERT
--   would error out. But that only works when the client requests
--   RETURNING via Prefer: return=representation. With
--   Prefer: return=minimal, PostgREST skips the RETURNING SELECT
--   and the row persists. An attacker can therefore call:
--
--     supabase
--       .from('leagues')
--       .insert({ commissioner_id: auth.uid(), name: 'Forge',
--                 status: 'completed', auction_budget: 99999,
--                 roster_size: 1, ... },
--               { returning: 'minimal' });
--
--   creating a phantom leagues row with arbitrary status/budget/
--   roster sizing that the legitimate create_league RPC would never
--   produce (e.g., status='completed' to skip drafting, oversized
--   auction_budget, undersized roster_size to misalign downstream
--   atomic functions). create_league is the only legitimate path
--   and it normalises all of those fields.
--
-- Strategy — REVOKE INSERT instead of just dropping the policies:
--   Dropping the RLS policies alone does NOT block INSERTs from a
--   role that has table-level INSERT GRANT — RLS denies by default
--   only when RLS is enabled AND no policy permits the action.
--   Removing the table-level INSERT privilege from authenticated
--   and anon is the airtight fix:
--
--     1. DROP POLICY IF EXISTS "leagues_insert"        ON public.leagues;
--     2. DROP POLICY IF EXISTS "league_members_insert" ON public.league_members;
--     3. REVOKE INSERT ON public.leagues        FROM authenticated, anon;
--     4. REVOKE INSERT ON public.league_members FROM authenticated, anon;
--
--   Service-role bypass:
--     The backend, Edge Functions, and the two legitimate SECURITY
--     DEFINER RPCs (public.create_league, public.join_league_by_invite_code)
--     all run with service_role privileges (either via the secret
--     key from the backend / Edge Functions, or via SECURITY DEFINER
--     execution which runs as the function owner — typically the
--     postgres superuser). service_role / postgres has BYPASSRLS
--     and is unaffected by REVOKE on authenticated/anon.
--
--     For defense-in-depth we restate the service_role INSERT GRANT
--     at the bottom of this migration: this is a no-op functionally
--     (service_role already inherits via inherited grants from the
--     postgres owner), but it documents intent so a future auditor
--     can confirm the legitimate write path is still open.
--
-- Audit (frontend + backend, performed for this slice):
--   • lib/league.ts:
--       - createLeague()             → supabase.rpc('create_league', …)
--       - joinLeague()               → supabase.rpc('join_league_by_invite_code', …)
--       Only .select() and .update() touch leagues / league_members.
--   • backend/src/ (authz, notifications, routes/{trades,waivers},
--     sync/{draft,rookieDraft,matchups,playoffs}):
--       Every reference to leagues / league_members is .select()
--       or .update(). No .insert() into either table from any
--       backend Fastify route or sync worker.
--   • supabase/functions/_shared/notifications.ts:
--       .from('league_members').select('user_id') only.
--   • supabase/migrations/*:
--       Every INSERT INTO public.leagues / public.league_members
--       lives inside a SECURITY DEFINER RPC (create_league,
--       join_league_by_invite_code, and their earlier variants).
--       SECURITY DEFINER runs as the function owner (postgres),
--       which bypasses the authenticated/anon GRANT restrictions.
--   • tests/e2e/soak.mjs and tests/e2e/seed-league.mjs:
--       Both files instantiate the Supabase client with
--       env.serviceRoleKey (createClient(url, serviceRoleKey, …)),
--       so their direct INSERTs into leagues / league_members run
--       as service_role and bypass the new REVOKE entirely.
--
-- Idempotent: DROP POLICY IF EXISTS + REVOKE are both safe to
-- re-run. REVOKE on a privilege that isn't held is a no-op (with
-- a NOTICE), not an error.
--
-- Rollback (only if a regression forces a direct-INSERT path back):
--   GRANT INSERT ON public.leagues        TO authenticated;
--   GRANT INSERT ON public.league_members TO authenticated;
--   CREATE POLICY "leagues_insert" ON public.leagues
--     FOR INSERT TO authenticated
--     WITH CHECK ((SELECT auth.uid()) = commissioner_id);
--   CREATE POLICY "league_members_insert" ON public.league_members
--     FOR INSERT TO authenticated
--     WITH CHECK ((SELECT auth.uid()) = user_id);
--   But every legitimate write path should remain on the
--   SECURITY DEFINER RPCs instead.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. Drop the now-obsolete INSERT policies. Removing the policy is not
--    enough on its own to block INSERTs (the GRANT is what matters
--    here), but leaving an unused policy in place is confusing for
--    future auditors and would re-open the hole if INSERT is ever
--    re-granted by mistake.
-- ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "leagues_insert"        ON public.leagues;
DROP POLICY IF EXISTS "league_members_insert" ON public.league_members;


-- ────────────────────────────────────────────────────────────────────────
-- 2. Revoke direct INSERT on both tables from end-user roles.
--    This is the airtight guard: even if a future migration
--    accidentally CREATEs a permissive INSERT policy, PostgREST
--    will still respond with 42501 "permission denied for table"
--    because the role lacks the underlying table-level INSERT
--    privilege.
-- ────────────────────────────────────────────────────────────────────────
REVOKE INSERT ON public.leagues        FROM authenticated;
REVOKE INSERT ON public.leagues        FROM anon;
REVOKE INSERT ON public.league_members FROM authenticated;
REVOKE INSERT ON public.league_members FROM anon;


-- ────────────────────────────────────────────────────────────────────────
-- 3. Defense-in-depth: restate the service_role INSERT GRANT.
--    service_role already bypasses RLS and inherits write
--    privileges via the postgres owner, but stating it
--    explicitly documents the legitimate write path for
--    create_league / join_league_by_invite_code.
-- ────────────────────────────────────────────────────────────────────────
GRANT INSERT ON public.leagues        TO service_role;
GRANT INSERT ON public.league_members TO service_role;


-- ────────────────────────────────────────────────────────────────────────
-- 4. Documentation comments — make it obvious to future readers
--    that these tables are now SECURITY DEFINER RPC-only from the
--    API layer. SELECT and UPDATE remain available to authenticated
--    members via their respective policies (untouched by this
--    migration); DELETE has never been permitted from clients.
-- ────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.leagues IS
  'League configuration / lifecycle. Reads: league members via '
  'leagues_select RLS policy. Updates: commissioners only, on a '
  'column-grant whitelist (migration 20260516300000_leagues_'
  'column_grants.sql). Inserts: the public.create_league '
  'SECURITY DEFINER RPC only — direct authenticated/anon INSERT '
  'was revoked in 20260516330000_revoke_direct_insert_leagues_'
  'members.sql to close the Prefer: return=minimal phantom-row '
  'bypass.';

COMMENT ON TABLE public.league_members IS
  'Per-league membership rows (commissioner, co_commissioner, '
  'manager). Reads: members of the same league via '
  'league_members_select. Updates: own row only, with role '
  'protected by the prevent_self_role_escalation trigger '
  '(migration 20260516260000_league_members_role_lockdown.sql). '
  'Inserts: the public.create_league and public.join_league_by_'
  'invite_code SECURITY DEFINER RPCs only — direct '
  'authenticated/anon INSERT was revoked in 20260516330000_'
  'revoke_direct_insert_leagues_members.sql to close the '
  'manager-INSERT bypass of join_league_by_invite_code.';
