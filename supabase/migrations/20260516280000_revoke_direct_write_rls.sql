-- ============================================================
-- Migration: Revoke direct authenticated INSERT/UPDATE/DELETE on
--   roster_players, weekly_lineups, waiver_wire_log, roster_transactions
--
-- SECURITY FIX:
--   Four tables retained direct authenticated INSERT/UPDATE/DELETE
--   policies that bypass the cap / lock / ownership / waiver-hold
--   checks encoded by the production atomic-RPC paths. All real
--   production write paths now flow through SECURITY DEFINER RPCs
--   invoked via service_role (which bypasses RLS):
--
--     roster_players
--       • add_free_agent_atomic              (FA pickup)
--       • drop_player_atomic                 (drop → 48h waiver hold)
--       • accept_trade_atomic                (party swap)
--       • complete_accepted_trade_atomic     (party swap on completion)
--       • process_next_waiver_claim_atomic   (waiver award)
--       • toggle_ir_atomic / toggle_taxi_atomic  (IR/taxi placement)
--       • make_snake_pick_atomic             (rookie draft pick)
--       • advance_season_atomic              (carry-over roster on rollover)
--
--     weekly_lineups
--       • set_player_slot_atomic             (manual slot move)
--       • auto_set_lineup_atomic             (auto-set day/week)
--
--     waiver_wire_log
--       • drop_player_atomic                 (48h hold insert)
--       • process_next_waiver_claim_atomic   (clear_at marker)
--       • backend processWaiverClaims (service-role UPDATE to mark expired)
--
--     roster_transactions
--       • every atomic RPC inserts the appropriate audit row
--
--   The direct RLS policies were a parallel path that, if invoked
--   from a forged client request, could:
--     • insert a roster row without spending a waiver hold,
--     • delete a roster row without writing the waiver_wire_log entry
--       or audit transaction,
--     • write a lineup slot for a player no longer owned,
--     • forge a roster_transactions audit row of arbitrary type,
--     • write a waiver_wire_log entry without the corresponding roster
--       deletion, leaving the player double-owned.
--
--   None of these are exercised by the current frontend code (audit
--   in slice B confirmed `lib/` and `app/` only SELECT from these
--   tables, except a dead `logTransaction()` in lib/transactions.ts
--   with no live callers). The policies are pure attack surface.
--
-- Strategy:
--   1. DROP the INSERT/UPDATE/DELETE policies for each of the four
--      tables. Keep all SELECT policies intact — clients still need
--      to read rosters, lineups, the waiver wire, and transaction
--      history.
--   2. Service-role bypass means every atomic-RPC path continues to
--      work unchanged: SECURITY DEFINER functions execute with the
--      function owner's privileges, and the backend / Edge Functions
--      authenticate with the service_role key which bypasses RLS
--      entirely (see migration 20260328000004 header).
--   3. Idempotent (DROP POLICY IF EXISTS) so the migration can be
--      re-applied to an already-locked database without error.
--
-- Rollback (per-policy, if a client path needs the direct policy
-- back — but every code path should go through an RPC instead):
--   See the original CREATE POLICY statements in
--   supabase/migrations/20260328000004_rls_policies.sql and the
--   roster-specific names in 20260512000001_harden_roster_trades.sql.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- roster_players
--
-- Current state after prior migrations:
--   - roster_players_select        (KEEP)
--   - roster_players_insert        (DROP — added by 20260328000004)
--   - roster_players_update_own    (already dropped 20260512000004; DROP idempotently)
--   - roster_players_delete_own    (DROP — added by 20260512000001)
--   - roster_players_update        (already dropped 20260512000001; DROP idempotently)
--   - roster_players_delete        (already dropped 20260512000001; DROP idempotently)
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "roster_players_insert"     ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_update"     ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_update_own" ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_delete"     ON public.roster_players;
DROP POLICY IF EXISTS "roster_players_delete_own" ON public.roster_players;


-- ─────────────────────────────────────────────────────────────
-- weekly_lineups
--
-- Current state after prior migrations:
--   - weekly_lineups_select   (KEEP)
--   - weekly_lineups_insert   (DROP)
--   - weekly_lineups_update   (DROP)
--   - weekly_lineups_delete   (DROP)
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "weekly_lineups_insert" ON public.weekly_lineups;
DROP POLICY IF EXISTS "weekly_lineups_update" ON public.weekly_lineups;
DROP POLICY IF EXISTS "weekly_lineups_delete" ON public.weekly_lineups;


-- ─────────────────────────────────────────────────────────────
-- waiver_wire_log
--
-- Current state after prior migrations:
--   - waiver_wire_log_select   (KEEP)
--   - waiver_wire_log_insert   (DROP)
--   (No UPDATE/DELETE client policy ever existed — service-role
--    clears `cleared_at` directly.)
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "waiver_wire_log_insert" ON public.waiver_wire_log;


-- ─────────────────────────────────────────────────────────────
-- roster_transactions
--
-- Current state after prior migrations:
--   - roster_transactions_select   (KEEP)
--   - roster_transactions_insert   (DROP)
--   (No UPDATE/DELETE client policy ever existed — the audit log
--    is append-only via atomic-RPC writes.)
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "roster_transactions_insert" ON public.roster_transactions;


-- ─────────────────────────────────────────────────────────────
-- Documentation comments — make it obvious to future readers that
-- these tables are now service-role-write-only from the API layer.
-- ─────────────────────────────────────────────────────────────
COMMENT ON TABLE public.roster_players IS
  'Roster ownership. Reads: league members via RLS select policy. '
  'Writes: SECURITY DEFINER atomic RPCs only (add_free_agent_atomic, '
  'drop_player_atomic, accept_trade_atomic, complete_accepted_trade_atomic, '
  'process_next_waiver_claim_atomic, toggle_ir_atomic, toggle_taxi_atomic, '
  'make_snake_pick_atomic, advance_season_atomic). Direct client INSERT/'
  'UPDATE/DELETE was revoked in 20260516280000_revoke_direct_write_rls.';

COMMENT ON TABLE public.weekly_lineups IS
  'Per-day starter/bench slot assignments. Reads: league members via '
  'RLS select policy. Writes: set_player_slot_atomic and '
  'auto_set_lineup_atomic only — both take pg_advisory_xact_lock '
  '(member_id, game_date) and re-verify roster ownership FOR SHARE. '
  'Direct client INSERT/UPDATE/DELETE was revoked in 20260516280000_'
  'revoke_direct_write_rls.';

COMMENT ON TABLE public.waiver_wire_log IS
  'Player waiver-hold records. Reads: league members via RLS select '
  'policy. Writes: drop_player_atomic inserts the 48h hold; '
  'process_next_waiver_claim_atomic and backend processWaiverClaims '
  'set cleared_at. Direct client INSERT was revoked in '
  '20260516280000_revoke_direct_write_rls.';

COMMENT ON TABLE public.roster_transactions IS
  'Append-only roster audit log (fa_add, fa_drop, waiver_add, '
  'waiver_drop, trade_in, trade_out, draft_won, etc.). Reads: league '
  'members via RLS select policy. Writes: every atomic RPC inserts the '
  'appropriate audit row. Direct client INSERT was revoked in '
  '20260516280000_revoke_direct_write_rls.';
