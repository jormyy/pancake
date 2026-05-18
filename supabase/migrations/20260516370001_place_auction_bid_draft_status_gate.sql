-- Gate place_auction_bid_atomic on drafts.status = 'in_progress'.
--
-- Finding:
-- - place_auction_bid_atomic currently checks nominations.status='open' but
--   never reads drafts.status. Sibling RPCs (make_snake_pick_atomic and the
--   backend nominatePlayer path) explicitly require drafts.status='in_progress'.
--   Without this gate, a commissioner pause/cancel of the draft can race
--   against in-flight bids, allowing budget/roster mutations after the draft
--   has been moved out of an active state.
--
-- This migration is idempotent: it CREATE OR REPLACEs the function with the
-- same signature, preserving all existing logic and lock ordering, and adds a
-- FOR UPDATE select on drafts plus a status check before any nomination
-- mutation. The grant/revoke pattern from the original migration is reapplied
-- so this stands alone if replayed.

DO $migration$
BEGIN
  EXECUTE $place_bid_sql$
CREATE OR REPLACE FUNCTION public.place_auction_bid_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_nomination_id uuid,
  p_amount int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nom nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_budget draft_budgets%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount < 1 THEN
    RAISE EXCEPTION 'Bid amount must be a positive integer';
  END IF;

  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND draft_id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nomination not found';
  END IF;

  -- Lock the draft row and require an active draft before mutating anything.
  -- Mirrors make_snake_pick_atomic's drafts.status='in_progress' gate so a
  -- paused/cancelled/completed draft cannot accept new bids.
  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  IF v_nom.status <> 'open' THEN
    RAISE EXCEPTION 'Bidding is closed for this nomination';
  END IF;

  IF v_nom.countdown_expires_at IS NULL OR v_nom.countdown_expires_at < now() THEN
    RAISE EXCEPTION 'Bidding has expired';
  END IF;

  IF p_amount <= v_nom.current_bid_amount THEN
    RAISE EXCEPTION 'Bid must exceed current bid of $%', v_nom.current_bid_amount;
  END IF;

  IF v_nom.current_bidder_id = p_member_id THEN
    RAISE EXCEPTION 'You are already the highest bidder';
  END IF;

  SELECT *
    INTO v_budget
    FROM draft_budgets
   WHERE draft_id = p_draft_id
     AND member_id = p_member_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft budget not found for bidder';
  END IF;

  IF v_budget.remaining < p_amount THEN
    RAISE EXCEPTION 'Insufficient budget (you have $% remaining)', v_budget.remaining;
  END IF;

  UPDATE nominations
     SET current_bid_amount = p_amount,
         current_bidder_id = p_member_id,
         countdown_expires_at = now() + interval '30 seconds'
   WHERE id = p_nomination_id;

  INSERT INTO bids (nomination_id, member_id, amount)
  VALUES (p_nomination_id, p_member_id, p_amount);
END;
$$;
$place_bid_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) TO service_role';
END
$migration$;
