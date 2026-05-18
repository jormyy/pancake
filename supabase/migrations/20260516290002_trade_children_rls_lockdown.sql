-- ============================================================
-- Migration: Lock down trade_items and trade_vetos child-table RLS
--
-- SECURITY FIXES (CRITICAL):
--
-- ISSUE 1 — trade_items injection during the 24h veto window
--   The original trade_items_insert policy (migration 20260328000004):
--
--     CREATE POLICY "trade_items_insert" ON trade_items
--       FOR INSERT TO authenticated
--       WITH CHECK (
--         trade_id IN (
--           SELECT t.id FROM trades t
--           WHERE  t.proposer_member_id IN (SELECT private.my_member_ids())
--         )
--       );
--
--   only restricts inserts to trades where the caller is the proposer,
--   but places NO bound on the parent trade's status. After the trade
--   is accepted, complete_accepted_trade_atomic (run by the cron at the
--   end of the 24h veto window) re-reads trade_items at completion and
--   moves every item whose from-side currently owns the asset. A
--   malicious proposer can therefore, during the veto window, run:
--
--     supabase.from('trade_items').insert({
--       trade_id:  '<my-accepted-trade>',
--       side:      'recipient',
--       player_id: '<recipient-star-player-uuid>',
--     });
--
--   The WITH CHECK passes (caller is the proposer, trade exists).
--   When complete_accepted_trade_atomic runs, the new item lists the
--   recipient as the from-side, so the recipient's star player is
--   moved to the proposer. Result: theft of any owned asset.
--
--   Mirror risk on UPDATE/DELETE: no UPDATE or DELETE policies were
--   ever defined for trade_items, so RLS denies them by default for
--   the authenticated role. We DO NOT add new UPDATE/DELETE policies
--   here. The original CREATE POLICY trade_items_insert is the only
--   user-writable surface, and we tighten it below. Parent-trade
--   cascade DELETE still works because cascades run as table-owner.
--
-- ISSUE 2 — trade_vetos missing league scope and veto_type guard
--   The original trade_vetos_insert policy (migration 20260328000004):
--
--     CREATE POLICY "trade_vetos_insert" ON trade_vetos
--       FOR INSERT TO authenticated
--       WITH CHECK (member_id IN (SELECT private.my_member_ids()));
--
--   only enforces that the caller's own member_id is the inserted
--   member_id. It does NOT verify:
--     (a) the trade_id resolves to a trade in one of the caller's
--         leagues (cross-league veto if a trade_id is leaked / guessed
--         — note: trade UUIDs are not predictable, but the row would
--         pollute another league's veto audit if obtained), AND
--     (b) the veto_type the caller sends. veto_type is an enum
--         ('commissioner' | 'member') used by the backend's veto-trade
--         route to instantly close a trade when veto_type='commissioner'
--         (see backend/src/routes/trades.ts: `const vetoed = isCommissioner
--         || ...`). A non-commissioner who inserts a veto row with
--         veto_type='commissioner' poisons the audit history with a
--         falsified commissioner action. While the backend route is the
--         only legitimate writer and re-derives veto_type itself, the
--         direct RLS path is a parallel surface that bypasses backend
--         policy. Lock the direct path to: caller must belong to the
--         trade's league AND veto_type='commissioner' is only allowed
--         if the caller is a commissioner of that league.
--
-- Strategy:
--   1. DROP and re-CREATE trade_items_insert with WITH CHECK that
--      additionally requires the parent trade to be in status='pending'.
--      Pre-accept is the only legitimate state in which items may be
--      attached. Once status moves to 'accepted', 'completed', 'vetoed',
--      'rejected', 'withdrawn', or 'expired', the trade's asset bundle
--      is frozen. The backend service-role propose-trade route (which
--      inserts all items in one batch before the trade ever leaves
--      'pending') bypasses RLS, so legitimate proposer-side multi-INSERT
--      is unaffected.
--
--   2. DROP and re-CREATE trade_vetos_insert with WITH CHECK that:
--        (a) keeps member_id IN my_member_ids (own-member),
--        (b) AND requires trade_id to belong to a trade in one of the
--            caller's leagues,
--        (c) AND for veto_type='commissioner', requires
--            private.is_commissioner(trade.league_id) = true.
--      member_id+league cross-check uses private.my_member_ids and the
--      trades lookup; veto_type guard scopes the trade's league to the
--      caller's commissioner status.
--
--   3. Service-role note: every legitimate write path (trade_items
--      inserts in /trades/propose, trade_vetos inserts in /trades/:id/veto)
--      runs as service_role and bypasses RLS entirely (see
--      20260328000004 header). The tightened WITH CHECK clauses only
--      affect direct PostgREST end-user inserts, which the React Native
--      frontend never performs (lib/trades.ts only SELECTs from these
--      tables; all writes go through the backend HTTPS API).
--
--   4. Idempotent: DROP POLICY IF EXISTS allows re-application.
--
-- Rollback:
--   DROP POLICY IF EXISTS "trade_items_insert" ON public.trade_items;
--   DROP POLICY IF EXISTS "trade_vetos_insert" ON public.trade_vetos;
--   -- Then re-CREATE the originals from 20260328000004_rls_policies.sql
--   -- if a regression is required.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. trade_items_insert — freeze items once the parent trade leaves
--    'pending'. Prevents post-accept theft via the veto-window window.
-- ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "trade_items_insert" ON public.trade_items;

CREATE POLICY "trade_items_insert" ON public.trade_items
  FOR INSERT TO authenticated
  WITH CHECK (
    trade_id IN (
      SELECT t.id
      FROM   public.trades t
      WHERE  t.proposer_member_id IN (SELECT private.my_member_ids())
        AND  t.status = 'pending'
    )
  );

COMMENT ON POLICY "trade_items_insert" ON public.trade_items IS
  'Allows the proposer (via own member_id) to attach trade items only '
  'while the parent trade is in status=''pending''. Once the trade has '
  'been accepted, completed, vetoed, rejected, withdrawn, or expired, '
  'the asset bundle is frozen. Closes a critical theft vector where a '
  'malicious proposer could inject ''side=recipient'' items during the '
  '24h veto window — complete_accepted_trade_atomic re-reads trade_items '
  'at completion and would move the recipient''s owned asset to the '
  'proposer. Service-role inserts (backend /trades/propose route) bypass '
  'RLS entirely and continue to work for the legitimate batch insert.';


-- ────────────────────────────────────────────────────────────────────────
-- 2. trade_vetos_insert — require league scope + commissioner-type guard.
-- ────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "trade_vetos_insert" ON public.trade_vetos;

CREATE POLICY "trade_vetos_insert" ON public.trade_vetos
  FOR INSERT TO authenticated
  WITH CHECK (
    member_id IN (SELECT private.my_member_ids())
    AND trade_id IN (
      SELECT t.id
      FROM   public.trades t
      WHERE  t.league_id IN (SELECT private.my_league_ids())
    )
    AND (
      veto_type = 'member'
      OR (
        veto_type = 'commissioner'
        AND EXISTS (
          SELECT 1
          FROM   public.trades t
          WHERE  t.id = trade_vetos.trade_id
            AND  private.is_commissioner(t.league_id)
        )
      )
    )
  );

COMMENT ON POLICY "trade_vetos_insert" ON public.trade_vetos IS
  'Allows a league member to insert a trade_vetos row only when: '
  '(a) member_id is the caller''s own league_members row, (b) the trade '
  'belongs to one of the caller''s leagues (closes a cross-league veto '
  'audit-poisoning gap), AND (c) veto_type=''commissioner'' is only '
  'allowed when the caller is actually a commissioner / co-commissioner '
  'of the trade''s league (closes a falsified-commissioner-action gap). '
  'Service-role inserts (backend /trades/:id/veto route) bypass RLS '
  'entirely; the backend re-derives veto_type from league_members.role '
  'and is the only legitimate writer in production.';
