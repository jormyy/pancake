-- ============================================================
-- Migration: Column-level UPDATE grants on public.leagues
--
-- SECURITY FIX (Slice A — iter 28):
--   The "leagues_update" RLS policy (most recently restated in
--   migration 20260516280000_rls_escalation_lockdown.sql) gates
--   UPDATEs by `private.is_commissioner(id)` but does NOT
--   constrain WHICH columns a commissioner may write. PostgreSQL
--   RLS is row-level, not column-level, so a commissioner armed
--   with the authenticated PostgREST role can directly UPDATE any
--   column on the row they own, including:
--
--     • status              — set 'active' to bypass the draft
--                              state-machine RPCs, or 'archived'
--                              to soft-DOS the league.
--     • name / slug         — rebrand or collide with another
--                              league's slug.
--     • invite_code         — invalidate every pending invite by
--                              rotating the code outside the
--                              backend rotate_invite_code RPC.
--     • commissioner_id     — reassign the chain-of-trust pointer.
--                              The iter 26 (RLS-escalation-lockdown)
--                              header explicitly noted this gap
--                              remains because the WITH CHECK
--                              mirror only protects row identity
--                              (id), not the commissioner_id field.
--     • trade_deadline      — fast-forward to lock out trades.
--
--   The only LEGITIMATE direct-update path from the frontend is
--   `updateLeague()` in lib/league.ts, which writes exactly seven
--   settings columns:
--
--     scoring_settings, roster_size, ir_slots, taxi_slots,
--     auction_budget, playoff_start_week, trade_deadline
--
--   Every status / lifecycle / invite-code mutation is supposed
--   to flow through a SECURITY DEFINER RPC or the backend
--   service-role client (e.g. open_draft, start_draft,
--   rotate_invite_code, advance_season_atomic, etc.). Those paths
--   bypass column grants because service_role has BYPASSRLS and
--   is not subject to GRANT-level column restrictions; SECURITY
--   DEFINER functions execute with their owner's privileges
--   (typically postgres / function-owner), so they too remain
--   unaffected.
--
-- Strategy — column-level GRANT:
--   PostgreSQL lets us revoke table-level UPDATE and re-grant
--   only the seven legit columns. After this migration, an
--   authenticated PostgREST UPDATE that touches any column NOT
--   in the grant list returns 42501 "permission denied for
--   column <name>", regardless of whether the RLS USING / WITH
--   CHECK passes. The RLS policy still gates the row (only
--   commissioners can hit any column), and the column grant
--   gates the columns (only settings columns are writable).
--
--   anon is included in the REVOKE for completeness — the
--   leagues_update policy already excludes anon, but a future
--   policy change that opens UPDATE to anon would otherwise
--   re-introduce the gap.
--
-- Service-role bypass — explicit GRANT for defense in depth:
--   The service_role / postgres roles bypass RLS *and* are not
--   constrained by column grants in the same way authenticated
--   users are, but as in 20260516290000_protect_push_token_column.sql
--   we restate the full-table UPDATE grant for service_role so
--   the intent is visible at the schema level and survives any
--   future tightening of bypass semantics.
--
-- Compatibility:
--   • lib/league.ts updateLeague() — UNAFFECTED. Writes a subset
--     of the granted columns.
--   • Backend lifecycle RPCs (set_league_status_atomic et al.)
--     and the backend service-role client — UNAFFECTED. They do
--     not use the authenticated role.
--   • create_league SECURITY DEFINER RPC — UNAFFECTED. It does
--     not UPDATE; it INSERTs (column grants on UPDATE do not
--     affect INSERT).
--
-- Idempotency:
--   REVOKE and GRANT are both idempotent for unchanged grant
--   state. Re-running this migration on an already-locked
--   database is a no-op.
--
-- Rollback (if a regression forces a temporary loosening):
--   GRANT UPDATE ON public.leagues TO authenticated;
--   -- This restores the pre-migration state. The RLS policy
--   -- still requires is_commissioner(id), so the rollback is
--   -- not catastrophic, but it re-opens the issue this slice
--   -- closes — prefer fixing the caller instead.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. Drop blanket table-level UPDATE for the PostgREST end-user roles.
-- ────────────────────────────────────────────────────────────────────────
REVOKE UPDATE ON public.leagues FROM authenticated;
REVOKE UPDATE ON public.leagues FROM anon;


-- ────────────────────────────────────────────────────────────────────────
-- 2. Re-grant UPDATE on the seven legitimate settings columns only.
--
--    Source of truth: lib/league.ts updateLeague() column union.
--    Adding a column here requires a matching change in that file
--    (and a security review — every new writable column is a new
--    attack surface).
-- ────────────────────────────────────────────────────────────────────────
GRANT UPDATE (
  scoring_settings,
  roster_size,
  ir_slots,
  taxi_slots,
  auction_budget,
  playoff_start_week,
  trade_deadline
) ON public.leagues TO authenticated;


-- ────────────────────────────────────────────────────────────────────────
-- 3. Restate service-role UPDATE grant for defense in depth.
--
--    Backend and SECURITY DEFINER paths already bypass GRANT
--    restrictions, but the explicit grant documents intent and
--    survives any future tightening of bypass semantics.
-- ────────────────────────────────────────────────────────────────────────
GRANT UPDATE ON public.leagues TO service_role;


-- ────────────────────────────────────────────────────────────────────────
-- 4. Schema-level documentation so future readers see the constraint.
-- ────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.leagues IS
  'League settings and lifecycle state. RLS leagues_update gates UPDATE '
  'rows by is_commissioner(id); column-level GRANTs (migration '
  '20260516300000_leagues_column_grants.sql) restrict authenticated '
  'UPDATEs to the seven settings columns (scoring_settings, roster_size, '
  'ir_slots, taxi_slots, auction_budget, playoff_start_week, '
  'trade_deadline). Writes to status, name, slug, invite_code, and '
  'commissioner_id must flow through SECURITY DEFINER RPCs or the '
  'backend service-role client, both of which bypass column grants.';
