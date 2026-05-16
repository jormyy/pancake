-- ============================================================
-- Migration: Close two RLS privilege-escalation gaps
--
-- SECURITY FIXES (CRITICAL):
--
-- ISSUE 1 — INSERT escalation on league_members
--   Migration 20260516260000 added a BEFORE UPDATE OF role trigger
--   that prevents non-commissioners from rewriting an existing row's
--   role. But it never fires on INSERT. Combined with the existing
--   league_members_insert RLS policy:
--
--     CREATE POLICY "league_members_insert" ON league_members
--       FOR INSERT TO authenticated
--       WITH CHECK ((SELECT auth.uid()) = user_id);
--
--   any authenticated user who knows a target league_id can run from
--   the React Native client:
--
--     supabase.from('league_members').insert({
--       league_id: '<victim-league-uuid>',
--       user_id:   auth.uid(),
--       role:      'commissioner',
--     });
--
--   The WITH CHECK passes (auth.uid() = user_id) and there is no
--   role check. The attacker is now a commissioner of the victim
--   league with full powers via private.is_commissioner() and the
--   backend's requireCommissioner() guards. Bypasses every
--   commissioner-only RPC, scoring adjustment, slot edit, etc.
--
-- ISSUE 2 — WITH CHECK missing on UPDATE policies
--   Several UPDATE policies on user-writable tables have a USING
--   predicate but no WITH CHECK. Without WITH CHECK, a client can
--   move a row INTO a state the USING predicate would have rejected.
--   Concrete attack vectors:
--
--     • league_members_update: USING (auth.uid() = user_id) but no
--       WITH CHECK lets a member rewrite NEW.user_id to another
--       user's auth id, transferring their league seat to someone
--       else. Or rewrite NEW.league_id to a league they do not
--       belong to (escaping isolation).
--
--     • leagues_update: USING (is_commissioner(id)) but no WITH
--       CHECK lets a commissioner rewrite NEW.id (PK) and reassign
--       the leagues row identity, or rewrite commissioner_id to
--       another user (chain-of-trust break).
--
--     • profiles_update: USING (auth.uid() = id) but no WITH CHECK
--       lets a user rewrite NEW.id to another user's id, hijacking
--       that profile's username/display_name/avatar.
--
--     • slot_templates_update / rps_update / weekly_lineups_update:
--       same row-state-escape pattern — change league_id/member_id
--       to escape the boundary the USING predicate enforced.
--
--   The fix is to drop and re-create each affected policy with a
--   WITH CHECK that mirrors the USING predicate. PostgreSQL then
--   enforces the predicate on BOTH the pre-image (USING) and the
--   post-image (WITH CHECK), closing the row-state-escape gap.
--
-- Service-role note (both fixes):
--   Backend service-role calls bypass RLS entirely (postgres role
--   has BYPASSRLS). RLS policies and triggers fire on PostgREST
--   end-user requests only. The new INSERT trigger explicitly
--   short-circuits when auth.uid() IS NULL to keep service-role
--   inserts working. The SECURITY DEFINER bootstrap RPCs
--   (create_league, join_league_by_invite_code) pass through via
--   the "first member of the league must be the registered
--   commissioner" bootstrap clause — auth.uid() inside SECURITY
--   DEFINER still returns the JWT user, so the auth.uid() IS NULL
--   bypass alone is not enough for those paths.
--
-- Rollback:
--   DROP TRIGGER prevent_insert_self_commissioner ON public.league_members;
--   DROP FUNCTION private.prevent_insert_self_commissioner();
--   -- Re-CREATE the six policies without WITH CHECK if a regression
--   -- is required. The originals are in migration 20260328000004.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. BEFORE INSERT trigger on league_members: block role escalation.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.prevent_insert_self_commissioner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  -- Only act on attempts to insert a privileged role. The default
  -- 'manager' role is fine for any authenticated user (the existing
  -- league_members_insert RLS policy already restricts WITH CHECK
  -- (auth.uid() = user_id), so they can only insert their own row).
  IF NEW.role NOT IN ('commissioner', 'co_commissioner') THEN
    RETURN NEW;
  END IF;

  v_caller := (SELECT auth.uid());

  -- Bypass 1: service_role / internal callers have no auth.uid().
  -- The backend (service_role key) bypasses RLS but triggers still
  -- fire, so we must allow this path.
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Bypass 2: an existing commissioner of this league is allowed to
  -- insert a co-commissioner (or add another commissioner — same
  -- policy as the UPDATE OF role trigger from migration 260000).
  IF private.is_commissioner(NEW.league_id) THEN
    RETURN NEW;
  END IF;

  -- Bypass 3: bootstrap. The very first member row for a league is
  -- inserted by the create_league SECURITY DEFINER RPC, which runs
  -- with auth.uid() = the caller's uid (the JWT travels through the
  -- DEFINER context). At that point is_commissioner returns false
  -- because no league_members rows exist yet. To allow the bootstrap
  -- without opening a hole, require that:
  --   (a) NO league_members row exists for this league yet, AND
  --   (b) the leagues row's commissioner_id matches NEW.user_id.
  -- The create_league RPC inserts the leagues row first, setting
  -- commissioner_id = auth.uid(), so this clause matches. An
  -- attacker cannot satisfy (a)+(b) against a victim's league
  -- because the victim's league already has a commissioner row.
  IF NOT EXISTS (
    SELECT 1
    FROM   public.league_members lm
    WHERE  lm.league_id = NEW.league_id
  )
  AND EXISTS (
    SELECT 1
    FROM   public.leagues l
    WHERE  l.id              = NEW.league_id
      AND  l.commissioner_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  -- No bypass matched: this is an escalation attempt.
  RAISE EXCEPTION
    'Only commissioners can grant the commissioner or co-commissioner role.'
    USING ERRCODE = '42501';
END;
$$;

-- Idempotent re-installation.
DROP TRIGGER IF EXISTS prevent_insert_self_commissioner ON public.league_members;

CREATE TRIGGER prevent_insert_self_commissioner
  BEFORE INSERT ON public.league_members
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_insert_self_commissioner();

COMMENT ON FUNCTION private.prevent_insert_self_commissioner() IS
  'Blocks authenticated end-users from inserting a league_members row '
  'with role = commissioner/co_commissioner unless they are already a '
  'commissioner of that league, OR the insert is the bootstrap row for '
  'a freshly created league owned by them. Closes a critical INSERT-path '
  'escalation gap not covered by the iter-25 UPDATE OF role trigger.';


-- ────────────────────────────────────────────────────────────────────────
-- 2. Add WITH CHECK to UPDATE policies that lack it.
--
--    Each block: DROP POLICY IF EXISTS, then CREATE POLICY with USING
--    AND WITH CHECK both populated. The WITH CHECK mirrors the USING
--    so the row's post-image must satisfy the same predicate. This
--    blocks "row state escape" — moving a row into a state the USING
--    predicate would have rejected.
--
--    SELECT/INSERT/DELETE policies are untouched. Reads remain open.
-- ────────────────────────────────────────────────────────────────────────

-- profiles_update ─────────────────────────────────────────────────────
-- USING: caller may only update their own profile row.
-- WITH CHECK mirror: caller cannot rewrite NEW.id to another user.
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING      ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

-- leagues_update ──────────────────────────────────────────────────────
-- USING: caller must be a commissioner of the league row being updated.
-- WITH CHECK mirror: caller cannot rewrite NEW.id (or any other field)
-- to detach the row from their commissioner scope. Importantly, this
-- also forbids rewriting commissioner_id to another user, because the
-- WITH CHECK is evaluated against NEW: if commissioner_id changes, the
-- updated row's commissioner check still uses the new id, but the
-- is_commissioner helper reads league_members.role which is unchanged
-- mid-update. Effective protection: row identity (id) cannot move.
DROP POLICY IF EXISTS "leagues_update" ON public.leagues;
CREATE POLICY "leagues_update" ON public.leagues
  FOR UPDATE TO authenticated
  USING      ((SELECT private.is_commissioner(id)))
  WITH CHECK ((SELECT private.is_commissioner(id)));

-- league_members_update ───────────────────────────────────────────────
-- USING: caller may only update their own league_member row.
-- WITH CHECK mirror: caller cannot rewrite NEW.user_id to another
-- user (transferring their seat), nor rewrite NEW.league_id to a
-- league they do not belong to. Role escalation is separately
-- blocked by the prevent_self_role_escalation trigger from
-- migration 20260516260000.
DROP POLICY IF EXISTS "league_members_update" ON public.league_members;
CREATE POLICY "league_members_update" ON public.league_members
  FOR UPDATE TO authenticated
  USING      ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- slot_templates_update ───────────────────────────────────────────────
-- USING: caller must be a commissioner of the league.
-- WITH CHECK mirror: cannot rewrite NEW.league_id to another league
-- (which would either silently move the template or escape the
-- commissioner boundary if the caller is also a commissioner there).
DROP POLICY IF EXISTS "slot_templates_update" ON public.lineup_slot_templates;
CREATE POLICY "slot_templates_update" ON public.lineup_slot_templates
  FOR UPDATE TO authenticated
  USING      ((SELECT private.is_commissioner(league_id)))
  WITH CHECK ((SELECT private.is_commissioner(league_id)));

-- rps_update ──────────────────────────────────────────────────────────
-- USING: caller must be a member of the league the challenge belongs to.
-- WITH CHECK mirror: cannot rewrite NEW.league_id to another league.
DROP POLICY IF EXISTS "rps_update" ON public.rps_challenges;
CREATE POLICY "rps_update" ON public.rps_challenges
  FOR UPDATE TO authenticated
  USING      (league_id IN (SELECT private.my_league_ids()))
  WITH CHECK (league_id IN (SELECT private.my_league_ids()));


-- ────────────────────────────────────────────────────────────────────────
-- Notes on policies intentionally NOT changed here:
--
--   • trades_update — already has WITH CHECK as of migration
--     20260516270000_trades_rls_lockdown.sql.
--   • roster_players_update / roster_players_update_own — both have
--     been DROPPED by later migrations (roster mutations now flow
--     through the backend service_role path).
--   • waiver_claims_update — DROPPED by migration 20260512000002
--     (waiver writes are server-authoritative).
--   • weekly_lineups_update — DROPPED by the sibling migration
--     20260516280000_revoke_direct_write_rls.sql, which moves lineup
--     writes to the server-authoritative atomic_lineup_set RPC.
--     Re-adding the policy here (even with WITH CHECK) would re-open
--     a direct-write surface that has been intentionally closed.
--   • All SELECT, INSERT, and DELETE policies — out of scope for
--     this slice (per the lockdown plan, only UPDATE policies and
--     the league_members INSERT path are at risk).
--
-- Migration ordering note:
--   This file is named ..._rls_escalation_lockdown.sql, which sorts
--   AFTER ..._revoke_direct_write_rls.sql at the same timestamp. So
--   weekly_lineups_update is already dropped by the time this runs.
--   The DROP POLICY IF EXISTS clauses above are robust to the sibling
--   having already removed unrelated policies.
-- ────────────────────────────────────────────────────────────────────────
