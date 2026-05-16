-- ============================================================
-- Migration: Lock down member-scope cross-league escapes
--
-- SECURITY FIXES (CRITICAL — discovered in iter 27 audit):
--
-- ISSUE A — league_members.league_id rewrite
--   Migration 20260516280000_rls_escalation_lockdown.sql gave
--   league_members_update a WITH CHECK of
--     (SELECT auth.uid()) = user_id
--   but no comparison against OLD.league_id. PostgreSQL's RLS
--   WITH CHECK can only see the post-image row (NEW); it cannot
--   reference OLD. The user_id mirror prevents seat-transfer but
--   does NOT prevent a user from rewriting their own row's
--   league_id to point at a victim league. After the rewrite,
--   private.my_league_ids() — which reads
--     SELECT league_id FROM league_members WHERE user_id = auth.uid()
--   — returns the victim's league_id, granting the attacker read
--   access (and any other my_league_ids()-gated path) to every
--   league-scoped row in that victim league: standings, weekly
--   lineups, rps_challenges, slot templates, etc.
--
--   The fix is a BEFORE UPDATE OF league_id trigger that raises
--   when an end-user attempts to change league_id. RLS cannot
--   express the OLD vs NEW comparison, but triggers can. The
--   trigger short-circuits when auth.uid() IS NULL so that the
--   service_role (backend) can still move members between leagues
--   for administrative operations (e.g. league merges, future
--   migrations) — the backend is trusted by definition.
--
-- ISSUE B — rps_challenges cross-league member ids
--   The rps_insert WITH CHECK from migration 000004 is only
--     league_id IN (SELECT private.my_league_ids())
--   and rps_update (after iter 26 escalation lockdown) is
--     USING+CHECK (league_id IN private.my_league_ids()).
--   Neither validates that NEW.member_a_id and NEW.member_b_id
--   are actually members of NEW.league_id. A caller in League X
--   can insert/update an rps_challenges row with
--     league_id    = X (passes WITH CHECK — they belong to X)
--     member_a_id  = <member of victim League Y>
--     member_b_id  = <another member of victim Y>
--   This pollutes League X's challenge feed with foreign member
--   ids and, more importantly, lets the attacker probe the
--   league_members table for valid uuids by trial-and-error
--   (REFERENCES league_members(id) FK errors leak membership
--   existence). It also enables denial-of-service shaped rows
--   (challenges referencing members who can never resolve them
--   because they don't belong to the league).
--
--   The fix is to drop and re-create rps_insert and rps_update
--   with an extended WITH CHECK that asserts both member_a_id
--   and member_b_id are rows in league_members whose league_id
--   matches NEW.league_id. Phrased as EXISTS subqueries against
--   public.league_members so PostgREST can plan them efficiently
--   given the existing (id) PK index.
--
-- Service-role bypass:
--   Both fixes preserve service_role write paths.
--     • league_members BEFORE UPDATE trigger short-circuits when
--       auth.uid() IS NULL.
--     • rps_challenges policies fire on end-user PostgREST calls
--       only; service_role bypasses RLS entirely.
--   Legitimate end-user self-edits (team_name, etc.) on
--   league_members remain allowed: the trigger only fires on
--   the league_id column.
--
-- Rollback:
--   DROP TRIGGER prevent_league_id_rewrite ON public.league_members;
--   DROP FUNCTION private.prevent_league_id_rewrite();
--   -- Re-create rps_insert / rps_update without the member-in-
--   -- league EXISTS clauses if a regression is required.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. league_members.league_id immutability for end users.
--
--    RLS WITH CHECK cannot reference OLD; use a BEFORE UPDATE OF
--    league_id trigger instead. Trigger fires per-row only when
--    the league_id column appears in the UPDATE statement's SET
--    list (BEFORE UPDATE OF column-list semantics), so unrelated
--    self-edits (team_name, etc.) skip the trigger entirely — no
--    extra overhead on the hot path.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.prevent_league_id_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  -- Only act if league_id actually changed. BEFORE UPDATE OF
  -- league_id is a hint (fires when league_id appears in SET);
  -- the actual value may not have changed if the client did
  --   UPDATE … SET league_id = league_id
  -- so we still need the IS DISTINCT FROM guard.
  IF NEW.league_id IS DISTINCT FROM OLD.league_id THEN
    v_caller := (SELECT auth.uid());

    -- Service role / internal callers have no auth.uid().
    -- The backend bypasses RLS but triggers still fire, so we
    -- must allow this path for administrative moves. End-user
    -- PostgREST calls always have a non-null auth.uid().
    IF v_caller IS NOT NULL THEN
      RAISE EXCEPTION
        'league_members.league_id is immutable for end users.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Idempotent re-installation.
DROP TRIGGER IF EXISTS prevent_league_id_rewrite ON public.league_members;

CREATE TRIGGER prevent_league_id_rewrite
  BEFORE UPDATE OF league_id ON public.league_members
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_league_id_rewrite();

COMMENT ON FUNCTION private.prevent_league_id_rewrite() IS
  'Blocks authenticated end-users from rewriting their league_members.league_id '
  'to a victim league. Without this, my_league_ids() would return the rewritten '
  'league and grant cross-league read access to every league-scoped table. '
  'Service-role bypasses via auth.uid() IS NULL for administrative moves.';


-- ────────────────────────────────────────────────────────────────────────
-- 2. rps_challenges: member_a_id and member_b_id must belong to league_id.
--
--    DROP+CREATE both rps_insert and rps_update with an extended
--    WITH CHECK predicate that asserts the cross-table invariant
--    via EXISTS subqueries against public.league_members. The
--    member uuids are FKs to league_members(id), so the EXISTS
--    rows are looked up by primary key (cheap, deterministic).
--
--    SELECT and DELETE policies on rps_challenges are unchanged.
-- ────────────────────────────────────────────────────────────────────────

-- rps_insert ──────────────────────────────────────────────────────────
-- USING n/a (INSERT only). WITH CHECK now layered:
--   (1) caller belongs to NEW.league_id (existing predicate), AND
--   (2) NEW.member_a_id is in NEW.league_id's roster, AND
--   (3) NEW.member_b_id is in NEW.league_id's roster.
DROP POLICY IF EXISTS "rps_insert" ON public.rps_challenges;
CREATE POLICY "rps_insert" ON public.rps_challenges
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND EXISTS (
      SELECT 1
      FROM   public.league_members lm
      WHERE  lm.id        = rps_challenges.member_a_id
        AND  lm.league_id = rps_challenges.league_id
    )
    AND EXISTS (
      SELECT 1
      FROM   public.league_members lm
      WHERE  lm.id        = rps_challenges.member_b_id
        AND  lm.league_id = rps_challenges.league_id
    )
  );

-- rps_update ──────────────────────────────────────────────────────────
-- USING mirrors the existing predicate from iter 26. WITH CHECK now
-- additionally asserts both members belong to NEW.league_id. Also
-- assert winner_member_id (when not null) belongs to NEW.league_id —
-- without this, a client could resolve a challenge with a foreign
-- member id and pollute downstream queries that JOIN on winner.
DROP POLICY IF EXISTS "rps_update" ON public.rps_challenges;
CREATE POLICY "rps_update" ON public.rps_challenges
  FOR UPDATE TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()))
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND EXISTS (
      SELECT 1
      FROM   public.league_members lm
      WHERE  lm.id        = rps_challenges.member_a_id
        AND  lm.league_id = rps_challenges.league_id
    )
    AND EXISTS (
      SELECT 1
      FROM   public.league_members lm
      WHERE  lm.id        = rps_challenges.member_b_id
        AND  lm.league_id = rps_challenges.league_id
    )
    AND (
      rps_challenges.winner_member_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM   public.league_members lm
        WHERE  lm.id        = rps_challenges.winner_member_id
          AND  lm.league_id = rps_challenges.league_id
      )
    )
  );


-- ────────────────────────────────────────────────────────────────────────
-- Notes on scope:
--
--   • The league_members BEFORE UPDATE trigger uses the column-list
--     form (BEFORE UPDATE OF league_id), so unrelated column updates
--     (team_name, draft_position, etc.) bypass the trigger entirely
--     for zero overhead on the legitimate self-edit path.
--
--   • We do NOT add a parallel INSERT-time validator for rps via a
--     trigger because the RLS WITH CHECK now covers the cross-table
--     invariant for the only writable paths (insert/update).
--
--   • If a future migration adds new rps_challenges columns that
--     reference league_members.id (e.g. a third participant), the
--     WITH CHECK clauses above must be extended in lockstep.
-- ────────────────────────────────────────────────────────────────────────
