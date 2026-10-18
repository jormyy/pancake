CREATE OR REPLACE FUNCTION public.place_auction_bid_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_nomination_id uuid,
  p_amount int,
  p_user_id uuid,
  p_to_taxi boolean DEFAULT false
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
  v_now timestamptz;
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

    IF p_to_taxi THEN
      PERFORM private.assert_taxi_acquisition_allowed(v_draft.league_id,v_draft.league_season_id,p_member_id,v_nom.player_id);
    ELSIF v_active_roster_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (%)', v_roster_size;
    END IF;
  END IF;

  v_now := clock_timestamp();
  IF v_nom.countdown_expires_at IS NULL OR v_nom.countdown_expires_at <= v_now THEN
    RAISE EXCEPTION 'Bidding has expired';
  END IF;

  UPDATE nominations
     SET current_bid_amount = p_amount,
         current_bidder_id = p_member_id,
         current_bid_to_taxi = COALESCE(p_to_taxi,false),
         countdown_expires_at = v_now + make_interval(secs => v_draft.pick_timer_seconds)
   WHERE id = p_nomination_id;

  INSERT INTO bids (nomination_id, member_id, amount, to_taxi)
  VALUES (p_nomination_id, p_member_id, p_amount, COALESCE(p_to_taxi,false));

  -- A manager may spend the whole remaining budget and fill open slots later
  -- through waivers or free agency, so the only bar to outbidding is the next
  -- dollar and room for this player in the active roster or taxi squad.
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
         AND (roster.active_count < v_roster_size OR private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,member.id,v_nom.player_id))
         AND budget.remaining >= v_next_bid
    )
      INTO v_can_outbid_exists;

    IF NOT v_can_outbid_exists THEN
      UPDATE nominations
         SET countdown_expires_at = clock_timestamp() - interval '1 millisecond'
       WHERE id = p_nomination_id
         AND status = 'open'::nomination_status;

      PERFORM public.close_auction_nomination_atomic(p_nomination_id);
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.make_snake_pick_atomic_internal(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_allow_expired_timer boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_next_pick snake_draft_picks%ROWTYPE;
  v_on_roster_id uuid;
  v_already_picked_id uuid;
  v_now timestamptz;
  v_remaining int;
  v_completed boolean := false;
  v_activated boolean := false;
  v_completion jsonb;
  v_rows int;
  v_next_timer_expires_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_player_id::text)
  );

  SELECT *
    INTO v_next_pick
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL
   ORDER BY overall_pick
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No picks remaining - draft may be complete'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_next_pick.member_id <> p_member_id THEN
    RAISE EXCEPTION 'It''s not your pick'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock AND v_next_pick.draft_pick_id IS NULL THEN
    RAISE EXCEPTION 'Draft slot is missing its draft-pick asset'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM players
   WHERE id = p_player_id
     AND years_exp = 0
     AND nba_draft_number IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rookie draft picks must select a rookie-eligible player'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    SELECT id
      INTO v_on_roster_id
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
     FOR UPDATE;

    IF v_on_roster_id IS NOT NULL THEN
      RAISE EXCEPTION 'Player is already on a roster' USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT id
    INTO v_already_picked_id
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id = p_player_id
   LIMIT 1;

  IF v_already_picked_id IS NOT NULL THEN
    RAISE EXCEPTION 'Player already picked in this draft'
      USING ERRCODE = '23505';
  END IF;

  v_now := clock_timestamp();
  IF NOT p_allow_expired_timer
     AND v_next_pick.timer_expires_at IS NOT NULL
     AND v_next_pick.timer_expires_at <= v_now THEN
    RAISE EXCEPTION 'Pick timer has expired'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE snake_draft_picks
     SET player_id = p_player_id,
         picked_at = v_now,
         to_taxi = COALESCE(p_to_taxi,false),
         skipped_at = NULL,
         skip_reason = NULL,
         timer_expires_at = NULL
   WHERE id = v_next_pick.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record snake draft pick atomically'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    IF p_to_taxi THEN
      PERFORM private.authorize_taxi_acquisition(v_draft.league_id,v_draft.league_season_id,p_member_id,p_player_id,'draft',p_draft_id);
    END IF;
    INSERT INTO roster_players (
      league_id,
      league_season_id,
      member_id,
      player_id,
      is_on_taxi,
      acquired_via
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      COALESCE(p_to_taxi,false),
      'draft'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      acquired_to_taxi,
      occurred_at
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      'draft_won',
      COALESCE(p_to_taxi,false),
      v_now
    );

    UPDATE draft_picks
       SET is_used = true,
           used_at = v_now,
           rookie_draft_id = p_draft_id
     WHERE id = v_next_pick.draft_pick_id
       AND league_id = v_draft.league_id
       AND current_owner_id = p_member_id
       AND round = v_next_pick.round
       AND is_used = false;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_remaining > 0 THEN
    v_next_timer_expires_at := private.arm_next_snake_pick_timer(
      p_draft_id,
      v_now + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  IF v_remaining = 0 THEN
    v_completion := private.complete_rookie_draft_if_ready(p_draft_id, v_now);
    v_completed := COALESCE((v_completion->>'completed')::boolean, false);
    v_activated := COALESCE((v_completion->>'activated')::boolean, false);
  END IF;

  RETURN jsonb_build_object(
    'pick', jsonb_build_object(
      'id', v_next_pick.id,
      'overall_pick', v_next_pick.overall_pick,
      'round', v_next_pick.round,
      'pick_in_round', v_next_pick.pick_in_round,
      'member_id', v_next_pick.member_id,
      'draft_pick_id', v_next_pick.draft_pick_id
    ),
    'player_id', p_player_id,
    'to_taxi', COALESCE(p_to_taxi,false),
    'remaining', v_remaining,
    'completed', v_completed,
    'activated', v_activated,
    'league_id', v_draft.league_id,
    'league_season_id', v_draft.league_season_id,
    'is_mock', v_draft.is_mock,
    'next_timer_expires_at', v_next_timer_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_expired_snake_pick_atomic(
  p_draft_id uuid
)
RETURNS TABLE (
  pick_id uuid,
  draft_id uuid,
  member_id uuid,
  player_id uuid,
  picked boolean,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_pick snake_draft_picks%ROWTYPE;
  v_player_id uuid;
  v_result jsonb;
  v_remaining int;
  v_rows int;
  v_now timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type
     OR v_draft.status <> 'in_progress'::draft_status THEN
    RETURN;
  END IF;

  v_now := clock_timestamp();

  SELECT pick.*
    INTO v_pick
    FROM snake_draft_picks AS pick
   WHERE pick.draft_id = p_draft_id
     AND pick.player_id IS NULL
     AND pick.skipped_at IS NULL
     AND pick.timer_expires_at IS NOT NULL
     AND pick.timer_expires_at < v_now
     AND NOT EXISTS (
       SELECT 1
         FROM snake_draft_picks AS earlier
        WHERE earlier.draft_id = pick.draft_id
          AND earlier.player_id IS NULL
          AND earlier.skipped_at IS NULL
          AND earlier.overall_pick < pick.overall_pick
     )
   ORDER BY pick.overall_pick, pick.id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  BEGIN
    IF v_draft.timer_expiry_behavior = 'skip_pick' THEN
      UPDATE snake_draft_picks AS pick
         SET skipped_at = v_now,
             skip_reason = 'timer_expired',
             timer_expires_at = NULL
       WHERE pick.id = v_pick.id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Expired snake pick was already resolved'
          USING ERRCODE = 'P0001';
      END IF;

      IF NOT v_draft.is_mock AND v_pick.draft_pick_id IS NOT NULL THEN
        UPDATE draft_picks
           SET is_used = true,
               used_at = v_now,
               rookie_draft_id = v_pick.draft_id
         WHERE id = v_pick.draft_pick_id
           AND league_id = v_draft.league_id
           AND current_owner_id = v_pick.member_id
           AND round = v_pick.round
           AND is_used = false;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
          RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
      VALUES (
        v_pick.draft_id,
        v_draft.league_id,
        NULL,
        'skip_pick',
        jsonb_build_object(
          'reason', 'timer_expired',
          'memberId', v_pick.member_id,
          'pickId', v_pick.id,
          'behavior', v_draft.timer_expiry_behavior
        )
      );

      SELECT count(*)
        INTO v_remaining
        FROM snake_draft_picks AS pick
       WHERE pick.draft_id = v_pick.draft_id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL;

      IF v_remaining > 0 THEN
        PERFORM private.arm_next_snake_pick_timer(
          v_pick.draft_id,
          v_now + make_interval(secs => v_draft.pick_timer_seconds)
        );
      ELSE
        PERFORM private.complete_rookie_draft_if_ready(v_pick.draft_id, v_now);
      END IF;

      RETURN QUERY
      SELECT
        v_pick.id,
        v_pick.draft_id,
        v_pick.member_id,
        NULL::uuid,
        false,
        NULL::text,
        NULL::text;

    ELSIF v_draft.timer_expiry_behavior IN ('pause_draft', 'commissioner_pick') THEN
      UPDATE snake_draft_picks AS pick
         SET timer_expires_at = NULL
       WHERE pick.id = v_pick.id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL;

      UPDATE drafts
         SET status = 'paused',
             paused_at = v_now,
             timer_paused_remaining_seconds = NULL,
             pause_reason = CASE
               WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
               ELSE 'timer_expired_pause'
             END
       WHERE id = v_pick.draft_id
         AND status = 'in_progress';

      INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
      VALUES (
        v_pick.draft_id,
        v_draft.league_id,
        NULL,
        CASE
          WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
          ELSE 'timer_expired_pause'
        END,
        jsonb_build_object(
          'memberId', v_pick.member_id,
          'pickId', v_pick.id,
          'behavior', v_draft.timer_expiry_behavior
        )
      );

      RETURN QUERY
      SELECT
        v_pick.id,
        v_pick.draft_id,
        v_pick.member_id,
        NULL::uuid,
        false,
        NULL::text,
        NULL::text;

    ELSE
      v_result := public.auto_pick_snake_pick_atomic(v_pick.draft_id, v_pick.member_id, 'timer_expired');
      v_player_id := (v_result->>'player_id')::uuid;

      RETURN QUERY
      SELECT
        v_pick.id,
        v_pick.draft_id,
        v_pick.member_id,
        v_player_id,
        true,
        NULL::text,
        NULL::text;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY
    SELECT
      v_pick.id,
      v_pick.draft_id,
      v_pick.member_id,
      v_player_id,
      false,
      SQLSTATE::text,
      SQLERRM::text;
  END;
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
     AND countdown_expires_at < clock_timestamp()
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
           closed_at = clock_timestamp()
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

      IF v_nom.current_bid_to_taxi THEN
        v_can_sell := private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,v_nom.current_bidder_id,v_nom.player_id);
      ELSIF v_active_roster_count >= v_roster_size THEN
        v_can_sell := false;
      ELSE
        v_can_sell := true;
      END IF;
    END IF;

    IF NOT v_can_sell THEN
      UPDATE nominations
         SET status = 'no_bid',
             closed_at = clock_timestamp()
       WHERE id = v_nom.id;
    ELSE
      UPDATE draft_budgets
         SET remaining = remaining - v_nom.current_bid_amount
       WHERE id = v_budget.id;

      IF NOT v_draft.is_mock THEN
        IF v_nom.current_bid_to_taxi THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id,v_draft.league_season_id,v_nom.current_bidder_id,v_nom.player_id,'draft',v_draft.id);
        END IF;
        INSERT INTO roster_players (
          league_id,
          league_season_id,
          member_id,
          player_id,
          acquired_via,
          is_on_taxi,
          acquisition_cost
        )
        VALUES (
          v_draft.league_id,
          v_draft.league_season_id,
          v_nom.current_bidder_id,
          v_nom.player_id,
          'draft',
          v_nom.current_bid_to_taxi,
          v_nom.current_bid_amount
        );

        INSERT INTO roster_transactions (
          league_id,
          league_season_id,
          member_id,
          player_id,
          transaction_type,
          acquired_to_taxi,
          related_nomination_id
        )
        VALUES (
          v_draft.league_id,
          v_draft.league_season_id,
          v_nom.current_bidder_id,
          v_nom.player_id,
          'draft_won',
          v_nom.current_bid_to_taxi,
          v_nom.id
        );
      END IF;

      UPDATE nominations
         SET status = 'sold',
             winning_member_id = v_nom.current_bidder_id,
             final_price = v_nom.current_bid_amount,
             closed_at = clock_timestamp()
       WHERE id = v_nom.id;
    END IF;
  ELSE
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = clock_timestamp()
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
         OR private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,lm.id,NULL,v_draft.id)
       )
  ) THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = clock_timestamp()
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
