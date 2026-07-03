-- Canonical SQL source for auction lifecycle.
-- Edit this file first, then copy changed function statements into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies the latest migration definitions still match.

CREATE OR REPLACE FUNCTION public.start_auction_draft_atomic(
  p_league_id uuid,
  p_nomination_order_mode text DEFAULT 'user_nominated',
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 30,
  p_budget_per_team int DEFAULT NULL,
  p_timer_expiry_behavior text DEFAULT 'auction_no_bid'
)
RETURNS drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
  v_budget int;
  v_is_mock boolean := COALESCE(p_is_mock, false);
BEGIN
  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode;
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
      USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_timer_expiry_behavior, 'auction_no_bid') <> 'auction_no_bid' THEN
    RAISE EXCEPTION 'Auction drafts use auction_no_bid timeout behavior.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF NOT v_is_mock AND v_league.status IS DISTINCT FROM 'setup'::league_status THEN
    RAISE EXCEPTION 'Auction draft can only start while league is setup';
  END IF;

  v_budget := COALESCE(p_budget_per_team, v_league.auction_budget);
  IF v_budget IS NULL OR v_budget <= 0 THEN
    RAISE EXCEPTION 'Auction budget must be a positive integer before starting a draft.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  IF NOT v_is_mock AND EXISTS (
    SELECT 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'auction'
       AND is_mock = false
       AND status <> 'cancelled'::draft_status
  ) THEN
    RAISE EXCEPTION 'A draft already exists for this league season';
  END IF;

  SELECT count(*) INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;
  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    budget_per_team,
    started_at,
    current_nomination_order,
    nomination_order_mode,
    is_mock,
    pick_timer_seconds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    'auction',
    'in_progress',
    v_budget,
    now(),
    1,
    p_nomination_order_mode,
    v_is_mock,
    p_pick_timer_seconds,
    'auction_no_bid'
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, lm.id, row_number() OVER (ORDER BY lm.joined_at ASC, lm.id ASC)::int
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  INSERT INTO draft_budgets (draft_id, member_id, initial_budget, remaining)
  SELECT v_draft.id, lm.id, v_budget, v_budget
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  IF NOT v_is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = p_league_id;
  END IF;

  RETURN v_draft;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_auction_nomination_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_user_id uuid,
  p_countdown_seconds int DEFAULT NULL
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
  v_countdown_seconds int;
BEGIN
  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  v_countdown_seconds := COALESCE(p_countdown_seconds, v_draft.pick_timer_seconds, 30);
  IF v_countdown_seconds < 5 OR v_countdown_seconds > 3600 THEN
    RAISE EXCEPTION 'Countdown seconds must be between 5 and 3600';
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
    hashtext(p_player_id::text)
  );

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

  IF NOT v_draft.is_mock AND EXISTS (
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
    now() + make_interval(secs => v_countdown_seconds)
  )
  RETURNING * INTO v_nomination;

  RETURN v_nomination;
END;
$$;

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
END;
$$;

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
  v_can_sell boolean;
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

  IF v_nom.current_bidder_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtext(v_draft.league_id::text),
      hashtext(v_nom.current_bidder_id::text)
    );
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(v_nom.player_id::text)
  );

  SELECT COALESCE(roster_size, 20)
    INTO v_roster_size
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT v_draft.is_mock AND EXISTS (
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

    v_can_sell := true;
    IF NOT v_draft.is_mock THEN
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
        v_can_sell := false;
      ELSE
        v_can_sell := true;
      END IF;
    END IF;

    IF NOT v_can_sell THEN
      UPDATE nominations
         SET status = 'no_bid',
             closed_at = now()
       WHERE id = v_nom.id;
    ELSE
      UPDATE draft_budgets
         SET remaining = remaining - v_nom.current_bid_amount
       WHERE id = v_budget.id;

      IF NOT v_draft.is_mock THEN
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
      END IF;

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
      FROM league_members lm
      JOIN draft_budgets db
        ON db.draft_id = v_nom.draft_id
       AND db.member_id = lm.id
     WHERE lm.league_id = v_draft.league_id
       AND db.remaining >= 1
       AND (
         v_draft.is_mock
         OR (
           SELECT count(*)
             FROM roster_players rp
            WHERE rp.league_id = v_draft.league_id
              AND rp.league_season_id = v_draft.league_season_id
              AND rp.member_id = lm.id
              AND COALESCE(rp.is_on_ir, false) = false
              AND COALESCE(rp.is_on_taxi, false) = false
         ) < v_roster_size
       )
  ) THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = now()
     WHERE id = v_nom.draft_id;

    IF NOT v_draft.is_mock THEN
      UPDATE leagues
         SET status = 'active'
       WHERE id = v_draft.league_id;
    END IF;
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_auction_nomination_atomic(
  p_nomination_id uuid,
  p_member_id uuid,
  p_user_id uuid
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
  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE id = p_member_id
       AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to act for this member'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT * INTO v_draft FROM drafts WHERE id = v_nom.draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;
  IF v_draft.status <> 'in_progress' THEN
    RETURN false;
  END IF;

  IF v_nom.nominating_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the nominator can withdraw this nomination'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_nom.current_bidder_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot withdraw a nomination after a bid has been placed'
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM nominations WHERE id = v_nom.id;

  RETURN true;
END;
$$;
