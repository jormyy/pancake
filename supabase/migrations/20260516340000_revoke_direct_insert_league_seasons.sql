-- ============================================================
-- Migration: Revoke direct authenticated/anon INSERT on
--   public.league_seasons
--
-- SECURITY FIX (CRITICAL):
--
-- ISSUE — league_seasons commissioner-INSERT phantom-row DoS
--   Migration 20260328000004_rls_policies.sql installed the
--   "league_seasons_insert" RLS policy:
--
--     CREATE POLICY "league_seasons_insert" ON league_seasons
--       FOR INSERT TO authenticated
--       WITH CHECK (
--         league_id IN (
--           SELECT l.id FROM leagues l
--           WHERE  l.commissioner_id = (SELECT auth.uid())
--         )
--       );
--
--   The policy allows any commissioner to directly INSERT season
--   rows for their own league. There is no DB-level UNIQUE
--   constraint enforcing "at most one row per league with
--   is_current = true". A commissioner — or any attacker who has
--   already compromised a commissioner account — can therefore
--   inject a phantom row from the React Native client:
--
--     supabase.from('league_seasons').insert({
--       league_id:   '<own-league-uuid>',
--       season_year: 9999,
--       is_current:  true,
--     });
--
--   The legitimate season row (created by public.create_league or
--   public.advance_season_atomic) already has is_current = true.
--   After the phantom INSERT, two rows match
--   (league_id = X AND is_current = true). Every read path in
--   lib/shared/season.ts and lib/transactions.ts (and the backend
--   sync workers in backend/src/sync/{draft,playoffs,rookieDraft}.ts
--   and backend/src/lib/utils/season.ts) calls:
--
--     supabase
--       .from('league_seasons')
--       .select(...)
--       .eq('league_id', leagueId)
--       .eq('is_current', true)
--       .single();
--
--   .single() is PostgREST's "exactly one row" mode and emits
--   406 / PGRST116 when more than one row matches. The whole
--   league is therefore self-DoSed: getCurrentSeason() returns
--   null on every call, breaking transactions history, draft
--   sync, playoff seeding, rookie-draft seeding, and matchup
--   sync until the phantom row is manually deleted via the
--   service role.
--
--   This is the same class of bug fixed in iter 31 for leagues /
--   league_members (20260516330000_revoke_direct_insert_leagues_
--   members.sql) — an INSERT policy that allowed direct client
--   writes when every legitimate write path was already a
--   SECURITY DEFINER RPC.
--
-- Strategy — REVOKE INSERT instead of just dropping the policy:
--   Dropping the RLS policy alone does NOT block INSERTs from a
--   role that has table-level INSERT GRANT — RLS denies by
--   default only when RLS is enabled AND no policy permits the
--   action. Removing the table-level INSERT privilege from
--   authenticated and anon is the airtight fix:
--
--     1. DROP POLICY IF EXISTS "league_seasons_insert"
--          ON public.league_seasons;
--     2. REVOKE INSERT ON public.league_seasons
--          FROM authenticated, anon;
--
--   Service-role bypass:
--     The two legitimate write paths are SECURITY DEFINER:
--       • public.create_league
--           (20260427000001_rpc_create_league.sql and the
--            dynamic-lifecycle variant in
--            20260512000008_dynamic_league_lifecycle_rpcs.sql)
--       • public.advance_season_atomic
--           (20260512000001_harden_roster_trades.sql — already
--            REVOKEs EXECUTE from authenticated/anon and GRANTs
--            EXECUTE to service_role only).
--     Both run as the function owner (postgres) which has
--     BYPASSRLS and inherits write privileges independent of
--     the authenticated/anon GRANT. Service-role callers
--     (backend, Edge Functions, soak / seed scripts) also
--     bypass RLS and retain INSERT.
--
--     For defense-in-depth we restate the service_role INSERT
--     GRANT at the bottom of this migration: this is a no-op
--     functionally but documents intent so a future auditor
--     can confirm the legitimate write path is still open.
--
-- Audit (frontend + backend, performed for this slice):
--   • lib/shared/season.ts:
--       - getCurrentSeason()    → .from('league_seasons').select(...)
--       - getActiveSeasonId()   → .from('league_seasons').select(...)
--       Only .select(). No .insert().
--   • lib/transactions.ts:
--       - getLeagueTransactions() → .from('league_seasons').select(...)
--       Only .select(). No .insert().
--   • backend/src/lib/utils/season.ts,
--     backend/src/sync/{draft,playoffs,rookieDraft}.ts:
--       Every reference to league_seasons is .select() (and the
--       backend's Supabase client is service-role anyway, so
--       any future .insert() there would still succeed).
--   • supabase/migrations/*:
--       Every INSERT INTO public.league_seasons lives inside a
--       SECURITY DEFINER RPC (create_league, advance_season_atomic,
--       and their earlier variants). SECURITY DEFINER runs as
--       the function owner (postgres), which bypasses the
--       authenticated/anon GRANT restrictions.
--   • tests/e2e/soak.mjs and tests/e2e/seed-league.mjs:
--       Both instantiate the Supabase client with the service
--       role key, so any direct INSERT into league_seasons in
--       those scripts runs as service_role and bypasses this
--       REVOKE entirely.
--
-- Idempotent: DROP POLICY IF EXISTS + REVOKE are both safe to
-- re-run. REVOKE on a privilege that isn't held is a no-op
-- (with a NOTICE), not an error.
--
-- Scope (DO NOT touch in this migration):
--   • league_seasons_select  — read path for members
--   • league_seasons_update  — currently no policy; commissioners
--     cannot UPDATE league_seasons from the client today
--   • league_seasons_delete  — currently no policy; clients
--     cannot DELETE league_seasons today
--   Only the INSERT policy + the underlying INSERT GRANT change.
--
-- Rollback (only if a regression forces a direct-INSERT path back):
--   GRANT INSERT ON public.league_seasons TO authenticated;
--   CREATE POLICY "league_seasons_insert" ON public.league_seasons
--     FOR INSERT TO authenticated
--     WITH CHECK (
--       league_id IN (
--         SELECT l.id FROM public.leagues l
--         WHERE  l.commissioner_id = (SELECT auth.uid())
--       )
--     );
--   But every legitimate write path should remain on the
--   SECURITY DEFINER RPCs (create_league, advance_season_atomic)
--   instead.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. Drop the now-obsolete INSERT policy. Removing the policy is not
--    enough on its own to block INSERTs (the GRANT is what matters
--    here), but leaving an unused policy in place is confusing for
--    future auditors and would re-open the hole if INSERT is ever
--    re-granted by mistake.
-- ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "league_seasons_insert" ON public.league_seasons;


-- ────────────────────────────────────────────────────────────────────────
-- 2. Revoke direct INSERT on league_seasons from end-user roles.
--    This is the airtight guard: even if a future migration
--    accidentally CREATEs a permissive INSERT policy, PostgREST
--    will still respond with 42501 "permission denied for table"
--    because the role lacks the underlying table-level INSERT
--    privilege.
-- ────────────────────────────────────────────────────────────────────────
REVOKE INSERT ON public.league_seasons FROM authenticated;
REVOKE INSERT ON public.league_seasons FROM anon;


-- ────────────────────────────────────────────────────────────────────────
-- 3. Defense-in-depth: restate the service_role INSERT GRANT.
--    service_role already bypasses RLS and inherits write
--    privileges via the postgres owner, but stating it
--    explicitly documents the legitimate write path for
--    create_league / advance_season_atomic.
-- ────────────────────────────────────────────────────────────────────────
GRANT INSERT ON public.league_seasons TO service_role;


-- ────────────────────────────────────────────────────────────────────────
-- 4. Documentation comment — make it obvious to future readers
--    that this table is now SECURITY DEFINER RPC-only from the
--    API layer. SELECT remains available to league members via
--    league_seasons_select (untouched by this migration); UPDATE
--    and DELETE have never been permitted from clients.
-- ────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.league_seasons IS
  'Per-league season rows (one row per league per season_year, '
  'with at most one is_current=true row per league enforced by '
  'application logic in the create_league and advance_season_'
  'atomic RPCs). Reads: league members via league_seasons_select. '
  'Inserts: the public.create_league and public.advance_season_'
  'atomic SECURITY DEFINER RPCs only — direct authenticated/anon '
  'INSERT was revoked in 20260516340000_revoke_direct_insert_'
  'league_seasons.sql to close the commissioner phantom-row '
  'is_current=true DoS that broke getCurrentSeason()''s .single().';
