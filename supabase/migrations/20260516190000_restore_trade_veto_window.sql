-- Restore the 24-hour trade veto window that was silently regressed.
--
-- Finding (iter 19, slice A):
-- - Migration 20260512000013 (trade veto window lifecycle) split trade
--   acceptance into two phases:
--     * accept_trade_atomic — just opens the veto window
--       (status='accepted', accepted_at=now(), veto_window_expires_at=now()+24h);
--       NO asset movement.
--     * complete_accepted_trade_atomic — runs after the veto window has
--       elapsed (driven by the iter 6 processAcceptedTrades cron); validates,
--       locks, and finally moves the player and draft-pick assets and sets
--       status='completed'.
-- - Migration 20260516173100 (clear_weekly_lineups_on_roster_moves) needed
--   to add a DELETE FROM weekly_lineups step inside accept_trade_atomic.
--   That migration was authored against the v1 (pre-veto-window) body from
--   20260512000001 and CREATE OR REPLACEd accept_trade_atomic back to a
--   single-phase function that moves assets immediately and jumps status
--   straight to 'completed'. The veto window feature was therefore silently
--   disabled:
--     * No trade ever sits in 'accepted'.
--     * veto_window_expires_at is never written.
--     * vetoTrade (backend/src/routes/trades.ts) always errors with
--       "This trade is not in its veto window".
--     * The processAcceptedTrades cron always finds zero work.
--
-- Strategy:
-- 1. CREATE OR REPLACE accept_trade_atomic with the canonical v2 body from
--    20260512000013, byte-for-byte. There are no roster moves in this phase,
--    so no weekly_lineups cleanup is necessary here.
-- 2. CREATE OR REPLACE complete_accepted_trade_atomic with the body from
--    20260512000013, but add the DELETE FROM weekly_lineups step from
--    20260516173100. Placement: between the validation/lock loop and the
--    asset-movement loop, which is the moment ownership actually changes
--    and matches the placement used for accept_trade_atomic in the original
--    weekly_lineups migration.

DO $migration$
BEGIN
  -- ────────────────────────────────────────────────────────────────────────
  -- accept_trade_atomic (PHASE 1): just open the veto window.
  -- Verbatim from 20260512000013_trade_veto_window_lifecycle.sql.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $accept_trade_sql$
CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_from_member uuid;
  v_rows int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'pending' THEN
    RAISE EXCEPTION 'This trade is no longer pending';
  END IF;

  IF v_trade.recipient_member_id <> p_accepting_member_id THEN
    RAISE EXCEPTION 'Only the recipient can accept this trade';
  END IF;

  -- Validate and lock every asset before opening the veto window. Assets do
  -- not move until complete_accepted_trade_atomic runs after the veto window.
  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected trade side';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'accepted',
         accepted_at = now(),
         veto_window_expires_at = now() + INTERVAL '24 hours',
         completed_at = NULL,
         vetoed_at = NULL
   WHERE id = p_trade_id
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to accept trade atomically';
  END IF;
END;
$$;
$accept_trade_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- complete_accepted_trade_atomic (PHASE 2): actually move assets after
  -- the veto window has elapsed. Body from 20260512000013 + the
  -- weekly_lineups cleanup that 20260516173100 had misplaced in
  -- accept_trade_atomic. The DELETE is positioned between the
  -- validation/lock loop and the asset-movement loop so it runs at the
  -- moment ownership changes hands.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $complete_trade_sql$
CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_rows int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'This trade is not accepted';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'The veto window is still open';
  END IF;

  -- Validate and lock every asset again at completion time. Any ownership
  -- drift during the veto window aborts the entire completion.
  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected trade side';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;
    END IF;
  END LOOP;

  -- Clear weekly_lineups for every player on either side of the trade so
  -- post-trade scoring won't credit the prior owner. Scoped by league_id;
  -- both legs may have lineup rows pointing at the same player_id, so wipe
  -- across the whole league. This was previously placed in
  -- accept_trade_atomic by migration 20260516173100, but assets do not move
  -- until this completion step, so the cleanup lives here.
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = v_trade.league_id
     AND wl.player_id IN (
       SELECT ti.player_id
         FROM trade_items AS ti
        WHERE ti.trade_id = p_trade_id
          AND ti.player_id IS NOT NULL
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;
    v_to_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade'
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically';
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', p_trade_id);
    ELSE
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically';
      END IF;
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         completed_at = now()
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;
END;
$$;
$complete_trade_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.complete_accepted_trade_atomic(uuid) TO service_role';
END
$migration$;
