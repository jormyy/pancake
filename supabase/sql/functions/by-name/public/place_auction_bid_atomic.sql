-- Canonical SQL source for public.place_auction_bid_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.place_auction_bid_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_nomination_id uuid,
  p_amount int,
  p_user_id uuid
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
  v_next_bid int;
  v_can_outbid_exists boolean := true;
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

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE id = p_member_id
       AND league_id = v_draft.league_id
       AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to act for this member'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(v_nom.player_id::text)
  );

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  IF v_nom.status <> 'open'::nomination_status THEN
    RAISE EXCEPTION 'Bidding is closed for this nomination';
  END IF;

  IF v_nom.countdown_expires_at IS NULL OR v_nom.countdown_expires_at < now() THEN
    RAISE EXCEPTION 'Bidding has expired';
  END IF;

  IF NOT v_draft.is_mock AND EXISTS (
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

  IF NOT v_draft.is_mock THEN
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
  END IF;

  UPDATE nominations
     SET current_bid_amount = p_amount,
         current_bidder_id = p_member_id,
         countdown_expires_at = now() + make_interval(secs => v_draft.pick_timer_seconds)
   WHERE id = p_nomination_id;

  INSERT INTO bids (nomination_id, member_id, amount)
  VALUES (p_nomination_id, p_member_id, p_amount);

  -- A manager may spend the whole remaining budget and fill open slots later
  -- through waivers or free agency, so the only bar to outbidding is the next
  -- dollar and an open active slot.
  IF NOT v_draft.is_mock THEN
    v_next_bid := p_amount + 1;
    SELECT EXISTS (
      SELECT 1
        FROM draft_budgets AS budget
        JOIN league_members AS member
          ON member.id = budget.member_id
         AND member.league_id = v_draft.league_id
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS active_count
            FROM roster_players AS rostered
           WHERE rostered.league_id = v_draft.league_id
             AND rostered.league_season_id = v_draft.league_season_id
             AND rostered.member_id = member.id
             AND COALESCE(rostered.is_on_ir, false) = false
             AND COALESCE(rostered.is_on_taxi, false) = false
        ) AS roster
       WHERE budget.draft_id = p_draft_id
         AND budget.member_id <> p_member_id
         AND roster.active_count < v_roster_size
         AND budget.remaining >= v_next_bid
    )
      INTO v_can_outbid_exists;

    IF NOT v_can_outbid_exists THEN
      UPDATE nominations
         SET countdown_expires_at = now() - interval '1 millisecond'
       WHERE id = p_nomination_id
         AND status = 'open'::nomination_status;

      PERFORM public.close_auction_nomination_atomic(p_nomination_id);
    END IF;
  END IF;
END;
$$;
