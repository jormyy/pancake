-- ============================================================
-- withdraw_auction_nomination_atomic — return the player to the pool
--
-- The prior version flipped the open nomination to status='withdrawn', but the
-- UNIQUE (draft_id, player_id) constraint plus the searchPlayers / nominate
-- guards (which match on draft_id+player_id regardless of status) then left the
-- player PERMANENTLY removed from the auction — so "withdraw" silently burned
-- the player. The intended "take it back" semantics is to void the nomination
-- and return the player to the auction pool.
--
-- Fix: DELETE the open, un-bid nomination row entirely (the player has no other
-- nominations row, so they reappear in search and can be nominated again — by
-- this manager or anyone). Withdraw is only allowed pre-bid, and bids cascade-
-- delete with the row anyway, so no bid/budget state is affected. Same auth as
-- before (caller owns the member AND is the nominator; draft in_progress).
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.withdraw_auction_nomination_atomic(
  p_nomination_id uuid,
  p_member_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nom   nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
BEGIN
  IF p_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM league_members WHERE id = p_member_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to act for this member' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false; -- already closed/awarded: nothing to take back
  END IF;

  SELECT * INTO v_draft FROM drafts WHERE id = v_nom.draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;
  IF v_draft.status <> 'in_progress' THEN
    RETURN false;
  END IF;

  IF v_nom.nominating_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the nominator can withdraw this nomination' USING ERRCODE = 'P0001';
  END IF;

  IF v_nom.current_bidder_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot withdraw a nomination after a bid has been placed' USING ERRCODE = 'P0001';
  END IF;

  -- Void the nomination entirely so the player returns to the auction pool.
  DELETE FROM nominations WHERE id = v_nom.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) TO service_role;
