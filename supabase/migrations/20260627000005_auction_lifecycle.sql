CREATE OR REPLACE FUNCTION public.create_auction_nomination_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_countdown_seconds int DEFAULT 30
)
RETURNS nominations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_nomination nominations%ROWTYPE;
  v_order_count int;
  v_expected_member_id uuid;
  v_nomination_order int;
BEGIN
  IF p_countdown_seconds IS NULL OR p_countdown_seconds < 1 THEN
    RAISE EXCEPTION 'Countdown seconds must be positive';
  END IF;

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  SELECT count(*)
    INTO v_order_count
    FROM draft_orders
   WHERE draft_id = p_draft_id;

  IF v_order_count <= 0 THEN
    RAISE EXCEPTION 'No draft order found';
  END IF;

  SELECT member_id
    INTO v_expected_member_id
    FROM draft_orders
   WHERE draft_id = p_draft_id
     AND position = (((v_draft.current_nomination_order - 1) % v_order_count) + 1);

  IF v_expected_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'It is not your turn to nominate';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM nominations
     WHERE draft_id = p_draft_id
       AND status = 'open'::nomination_status
  ) THEN
    RAISE EXCEPTION 'A nomination is already open - wait for it to close';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM nominations
     WHERE draft_id = p_draft_id
       AND player_id = p_player_id
  ) THEN
    RAISE EXCEPTION 'Player already nominated in this draft';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
  ) THEN
    RAISE EXCEPTION 'Player is already rostered';
  END IF;

  SELECT count(*) + 1
    INTO v_nomination_order
    FROM nominations
   WHERE draft_id = p_draft_id;

  INSERT INTO nominations (
    draft_id,
    nominating_member_id,
    player_id,
    nomination_order,
    status,
    current_bid_amount,
    current_bidder_id,
    countdown_expires_at
  )
  VALUES (
    p_draft_id,
    p_member_id,
    p_player_id,
    v_nomination_order,
    'open',
    0,
    NULL,
    now() + make_interval(secs => p_countdown_seconds)
  )
  RETURNING * INTO v_nomination;

  RETURN v_nomination;
END;
$$;

REVOKE ALL ON FUNCTION public.create_auction_nomination_atomic(uuid, uuid, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_auction_nomination_atomic(uuid, uuid, uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.create_auction_nomination_atomic(uuid, uuid, uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_auction_nomination_atomic(uuid, uuid, uuid, int) TO service_role;

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
  v_roster_size int;
  v_active_roster_count int;
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

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  IF v_nom.status <> 'open'::nomination_status THEN
    RAISE EXCEPTION 'Bidding is closed for this nomination';
  END IF;

  IF v_nom.countdown_expires_at IS NULL OR v_nom.countdown_expires_at < now() THEN
    RAISE EXCEPTION 'Bidding has expired';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = v_nom.player_id
  ) THEN
    RAISE EXCEPTION 'Player is already rostered';
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

  SELECT COALESCE(roster_size, 20)
    INTO v_roster_size
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  PERFORM 1
    FROM roster_players
   WHERE league_id = v_draft.league_id
     AND league_season_id = v_draft.league_season_id
     AND member_id = p_member_id
     AND COALESCE(is_on_ir, false) = false
     AND COALESCE(is_on_taxi, false) = false
   FOR UPDATE;

  SELECT count(*)
    INTO v_active_roster_count
    FROM roster_players
   WHERE league_id = v_draft.league_id
     AND league_season_id = v_draft.league_season_id
     AND member_id = p_member_id
     AND COALESCE(is_on_ir, false) = false
     AND COALESCE(is_on_taxi, false) = false;

  IF v_active_roster_count >= v_roster_size THEN
    RAISE EXCEPTION 'Your active roster is full (%)', v_roster_size;
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

REVOKE ALL ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.place_auction_bid_atomic(uuid, uuid, uuid, int) TO service_role;

CREATE OR REPLACE FUNCTION public.close_auction_nomination_atomic(
  p_nomination_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nom nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_budget draft_budgets%ROWTYPE;
  v_roster_size int;
  v_active_roster_count int;
BEGIN
  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
     AND countdown_expires_at < now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = v_nom.draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RETURN false;
  END IF;

  SELECT COALESCE(roster_size, 20)
    INTO v_roster_size
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = v_nom.player_id
  ) THEN
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = now()
     WHERE id = v_nom.id;
  ELSIF v_nom.current_bidder_id IS NOT NULL THEN
    SELECT *
      INTO v_budget
      FROM draft_budgets
     WHERE draft_id = v_nom.draft_id
       AND member_id = v_nom.current_bidder_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Winning bidder budget not found';
    END IF;

    IF v_budget.remaining < v_nom.current_bid_amount THEN
      RAISE EXCEPTION 'Winning bidder no longer has enough remaining budget';
    END IF;

    PERFORM 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND member_id = v_nom.current_bidder_id
       AND COALESCE(is_on_ir, false) = false
       AND COALESCE(is_on_taxi, false) = false
     FOR UPDATE;

    SELECT count(*)
      INTO v_active_roster_count
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND member_id = v_nom.current_bidder_id
       AND COALESCE(is_on_ir, false) = false
       AND COALESCE(is_on_taxi, false) = false;

    IF v_active_roster_count >= v_roster_size THEN
      UPDATE nominations
         SET status = 'no_bid',
             closed_at = now()
       WHERE id = v_nom.id;
    ELSE
      UPDATE draft_budgets
         SET remaining = remaining - v_nom.current_bid_amount
       WHERE id = v_budget.id;

      INSERT INTO roster_players (
        league_id,
        league_season_id,
        member_id,
        player_id,
        acquired_via,
        acquisition_cost
      )
      VALUES (
        v_draft.league_id,
        v_draft.league_season_id,
        v_nom.current_bidder_id,
        v_nom.player_id,
        'draft',
        v_nom.current_bid_amount
      );

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_nomination_id
      )
      VALUES (
        v_draft.league_id,
        v_draft.league_season_id,
        v_nom.current_bidder_id,
        v_nom.player_id,
        'draft_won',
        v_nom.id
      );

      UPDATE nominations
         SET status = 'sold',
             winning_member_id = v_nom.current_bidder_id,
             final_price = v_nom.current_bid_amount,
             closed_at = now()
       WHERE id = v_nom.id;
    END IF;
  ELSE
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = now()
     WHERE id = v_nom.id;
  END IF;

  UPDATE drafts
     SET current_nomination_order = current_nomination_order + 1
   WHERE id = v_nom.draft_id;

  IF NOT EXISTS (
    SELECT 1
      FROM draft_budgets
     WHERE draft_id = v_nom.draft_id
       AND remaining >= 1
  ) OR NOT EXISTS (
    SELECT 1
      FROM league_members lm
     WHERE lm.league_id = v_draft.league_id
       AND (
         SELECT count(*)
           FROM roster_players rp
          WHERE rp.league_id = v_draft.league_id
            AND rp.league_season_id = v_draft.league_season_id
            AND rp.member_id = lm.id
            AND COALESCE(rp.is_on_ir, false) = false
            AND COALESCE(rp.is_on_taxi, false) = false
       ) < v_roster_size
  ) THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = now()
     WHERE id = v_nom.draft_id;

    UPDATE leagues
       SET status = 'active'
     WHERE id = v_draft.league_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.close_auction_nomination_atomic(uuid) TO service_role;
