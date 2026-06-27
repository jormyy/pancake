-- ============================================================
-- withdraw_auction_nomination_atomic
--
-- Lets the nominator take back ("give up" on) an OPEN auction nomination they
-- created, but only before any competing bid — once someone bids, the market
-- decides and there are no take-backs. Withdrawing voids the nomination, frees
-- the player to be nominated again, and keeps the same member on the clock so
-- they can nominate a different player.
--
-- service_role-only (like the other auction RPCs): reached through the backend
-- /draft/:id/withdraw-nomination route, which re-derives the member from the
-- authenticated JWT. The RPC additionally verifies caller ownership and that
-- the caller is the nominator, so it is safe even if the grant ever widened.
-- Idempotent (CREATE OR REPLACE).
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
  -- The acting member must be owned by the JWT user (when provided).
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
  -- Already closed/awarded/withdrawn: nothing to take back (idempotent no-op).
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT * INTO v_draft FROM drafts WHERE id = v_nom.draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  -- Don't mutate a paused/cancelled/completed draft.
  IF v_draft.status <> 'in_progress' THEN
    RETURN false;
  END IF;

  IF v_nom.nominating_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the nominator can withdraw this nomination' USING ERRCODE = 'P0001';
  END IF;

  -- Once any competing bid exists, the nomination is binding.
  IF v_nom.current_bidder_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot withdraw a nomination after a bid has been placed' USING ERRCODE = 'P0001';
  END IF;

  UPDATE nominations
     SET status = 'withdrawn',
         closed_at = now()
   WHERE id = v_nom.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_auction_nomination_atomic(uuid, uuid, uuid) TO service_role;
