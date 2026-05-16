-- ============================================================
-- Migration: Lock down trades.status escalation via RLS + trigger
--
-- SECURITY FIX (CRITICAL):
--   The existing trades_update policy (migration 20260328000004) is:
--
--     CREATE POLICY "trades_update" ON trades
--       FOR UPDATE TO authenticated
--       USING (
--         proposer_member_id  IN (SELECT private.my_member_ids())
--         OR recipient_member_id IN (SELECT private.my_member_ids())
--       );
--
--   It has a USING predicate but NO WITH CHECK clause. A trade party
--   can therefore directly do this from the React Native client:
--
--     supabase.from('trades')
--       .update({ status: 'completed' })   -- or 'accepted'
--       .eq('id', myTradeId)
--
--   The post-update row still satisfies USING (proposer/recipient
--   unchanged), so the update succeeds. This bypasses:
--     • accept_trade_atomic         — opens 24h veto window, locks assets
--     • complete_accepted_trade_atomic — validates ownership, moves assets,
--                                        writes roster_transactions audit,
--                                        clears weekly_lineups
--     • vetoTrade / rejectTrade / withdrawTrade — backend authorization,
--       member-veto threshold counting, notifications
--
--   Worse, the row could be mutated to rewrite proposer_member_id /
--   recipient_member_id to OTHER members, since WITH CHECK is not enforced
--   on the post-image — escaping the USING predicate entirely.
--
-- Strategy:
--   1. DROP and re-CREATE trades_update with USING AND WITH CHECK both
--      enforcing membership of either side. This blocks post-image
--      escape: a client cannot rewrite proposer/recipient to another
--      member's id because the new row would fail WITH CHECK.
--
--   2. Add a BEFORE UPDATE trigger that rejects status/timestamp
--      transitions unless auth.uid() IS NULL (service-role path).
--      All legitimate status mutations flow through:
--        - accept_trade_atomic / complete_accepted_trade_atomic (SECURITY
--          DEFINER RPCs invoked by backend service-role)
--        - vetoTrade / rejectTrade / withdrawTrade in backend/src/routes/trades.ts
--          (service-role client)
--      All of these have auth.uid() = NULL, so they pass through. End-user
--      PostgREST updates always have a non-null auth.uid() and are blocked.
--
--   3. The trigger also guards completed_at, accepted_at,
--      veto_window_expires_at, vetoed_at — these are the timestamps the
--      atomic RPCs manage. Rewriting them client-side could fake a
--      completed trade or short-circuit the veto window. We do NOT guard
--      `notes`, `proposed_at`, `league_id`, `league_season_id`, etc.
--      Trade parties retain the ability to do legitimate non-status
--      self-edits (notes is the only realistic candidate today).
--
-- Rollback:
--   DROP TRIGGER prevent_trade_status_client_writes ON public.trades;
--   DROP FUNCTION private.prevent_trade_status_client_writes();
--   -- Then re-CREATE the original trades_update policy without WITH CHECK
--   -- if a regression is required.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. Replace trades_update policy: add WITH CHECK mirror of USING.
-- ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "trades_update" ON public.trades;

CREATE POLICY "trades_update" ON public.trades
  FOR UPDATE TO authenticated
  USING (
    proposer_member_id  IN (SELECT private.my_member_ids())
    OR recipient_member_id IN (SELECT private.my_member_ids())
  )
  WITH CHECK (
    proposer_member_id  IN (SELECT private.my_member_ids())
    OR recipient_member_id IN (SELECT private.my_member_ids())
  );


-- ────────────────────────────────────────────────────────────────────────
-- 2. BEFORE UPDATE trigger: block client-side mutation of status and
--    its accompanying lifecycle timestamps. Service-role bypass via
--    auth.uid() IS NULL.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.prevent_trade_status_client_writes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  v_caller := (SELECT auth.uid());

  -- Service role / internal SECURITY DEFINER RPCs run with auth.uid() = NULL.
  -- All legitimate status transitions (accept / complete / veto / reject /
  -- withdraw) flow through service-role paths, so we trust them.
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Authenticated end-user path: any change to status or to a
  -- lifecycle timestamp is forbidden. These are exclusively owned by
  -- the atomic RPCs and backend routes.
  IF NEW.status                 IS DISTINCT FROM OLD.status
     OR NEW.accepted_at            IS DISTINCT FROM OLD.accepted_at
     OR NEW.veto_window_expires_at IS DISTINCT FROM OLD.veto_window_expires_at
     OR NEW.completed_at           IS DISTINCT FROM OLD.completed_at
     OR NEW.vetoed_at              IS DISTINCT FROM OLD.vetoed_at
  THEN
    RAISE EXCEPTION
      'Trade status and lifecycle timestamps can only be changed via the trade RPCs.'
      USING ERRCODE = '42501';
  END IF;

  -- Also forbid rewriting the trade parties themselves. The WITH CHECK
  -- on the policy already prevents reassignment AWAY from the caller,
  -- but defense-in-depth: forbid any change to proposer/recipient or
  -- league/season scoping fields from the client path entirely.
  IF NEW.proposer_member_id  IS DISTINCT FROM OLD.proposer_member_id
     OR NEW.recipient_member_id IS DISTINCT FROM OLD.recipient_member_id
     OR NEW.league_id           IS DISTINCT FROM OLD.league_id
     OR NEW.league_season_id    IS DISTINCT FROM OLD.league_season_id
     OR NEW.proposed_at          IS DISTINCT FROM OLD.proposed_at
  THEN
    RAISE EXCEPTION
      'Trade identity fields are immutable from client-side updates.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- Idempotent re-installation.
DROP TRIGGER IF EXISTS prevent_trade_status_client_writes ON public.trades;

CREATE TRIGGER prevent_trade_status_client_writes
  BEFORE UPDATE ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_trade_status_client_writes();

COMMENT ON FUNCTION private.prevent_trade_status_client_writes() IS
  'Blocks authenticated end-users from directly mutating trades.status, '
  'lifecycle timestamps, or party fields. Closes a critical bypass of the '
  'veto window, asset transfer, and notification flows in the trades_update '
  'RLS policy. Service-role calls (auth.uid() IS NULL) pass through; the '
  'atomic RPCs (accept_trade_atomic, complete_accepted_trade_atomic) and '
  'backend routes (vetoTrade, rejectTrade, withdrawTrade) own all '
  'status transitions.';
