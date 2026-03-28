-- ============================================================
-- Migration: RLS Helper Functions
--
-- Creates a private schema with SECURITY DEFINER helper functions
-- for Row Level Security policy evaluation.
--
-- Key design choices:
--   • Functions live in a `private` schema — PostgREST only exposes
--     the `public` schema, so these cannot be called directly by clients.
--   • SECURITY DEFINER + SET search_path = '' prevents search_path
--     injection attacks.
--   • All auth.uid() calls are wrapped in (SELECT auth.uid()) to trigger
--     PostgreSQL's initPlan optimisation — the result is cached once per
--     statement rather than re-evaluated for every row scanned. Supabase
--     docs report up to 95% query latency improvement from this alone.
--   • The composite index below powers every RLS membership check with
--     a single index scan on (user_id, league_id).
-- ============================================================

CREATE SCHEMA IF NOT EXISTS private;

-- ── my_league_ids ─────────────────────────────────────────────
-- Returns the set of league UUIDs the current user belongs to.
-- Used in USING clauses for all league-scoped tables.
CREATE OR REPLACE FUNCTION private.my_league_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT league_id
  FROM   public.league_members
  WHERE  user_id = (SELECT auth.uid())
$$;

-- ── my_member_ids ─────────────────────────────────────────────
-- Returns the set of league_member UUIDs belonging to the current user.
-- Used in WITH CHECK clauses for roster/lineup write policies.
CREATE OR REPLACE FUNCTION private.my_member_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id
  FROM   public.league_members
  WHERE  user_id = (SELECT auth.uid())
$$;

-- ── is_league_member ──────────────────────────────────────────
-- Boolean check: is the current user a member of a specific league?
-- Prefer my_league_ids() IN subquery for bulk policies; use this
-- for targeted single-league checks (e.g. commissoner-only routes).
CREATE OR REPLACE FUNCTION private.is_league_member(p_league_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.league_members
    WHERE  league_id = p_league_id
      AND  user_id   = (SELECT auth.uid())
  )
$$;

-- ── is_commissioner ───────────────────────────────────────────
-- Boolean check: is the current user a commissioner or
-- co-commissioner of a specific league?
CREATE OR REPLACE FUNCTION private.is_commissioner(p_league_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.league_members
    WHERE  league_id = p_league_id
      AND  user_id   = (SELECT auth.uid())
      AND  role      IN ('commissioner', 'co_commissioner')
  )
$$;

-- ── Critical composite index ───────────────────────────────────
-- Every RLS policy that calls my_league_ids() or my_member_ids()
-- performs a lookup on (user_id, league_id). Without this index
-- those lookups are sequential scans. A single index here powers
-- the hot path for every authenticated request in the app.
CREATE INDEX IF NOT EXISTS idx_league_members_user_league
  ON public.league_members(user_id, league_id);
