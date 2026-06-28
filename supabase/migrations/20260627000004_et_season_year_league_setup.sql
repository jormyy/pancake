CREATE OR REPLACE FUNCTION public.current_season_year_et(
  p_now timestamptz DEFAULT now()
)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN extract(month FROM timezone('America/New_York', p_now)) >= 10
      THEN extract(year FROM timezone('America/New_York', p_now))::int + 1
    ELSE extract(year FROM timezone('America/New_York', p_now))::int
  END
$$;

CREATE OR REPLACE FUNCTION public.create_league(
  p_name           text,
  p_team_name      text,
  p_auction_budget int DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id          uuid := (SELECT auth.uid());
  v_slug             text;
  v_invite_code      text;
  v_league_id        uuid;
  v_member_id        uuid;
  v_league_season_id uuid;
  v_season_year      int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_auction_budget IS NULL OR p_auction_budget <= 0 THEN
    RAISE EXCEPTION 'auction_budget must be a positive integer.'
      USING ERRCODE = 'P0001';
  END IF;

  v_season_year := public.current_season_year_et();

  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
            || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', trim(p_team_name))
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_league_season_id, v_member_id, 1);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year + 1, v_season_year + 5) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value;

  RETURN jsonb_build_object(
    'id',              v_league_id,
    'name',            trim(p_name),
    'slug',            v_slug,
    'invite_code',     v_invite_code,
    'commissioner_id', v_user_id,
    'auction_budget',  p_auction_budget,
    'status',          'setup'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.current_season_year_et(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_season_year_et(timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_league(text, text, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_auction_draft_atomic(
  p_league_id uuid,
  p_nomination_order_mode text DEFAULT 'user_nominated'
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
BEGIN
  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode;
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status IS DISTINCT FROM 'setup'::league_status THEN
    RAISE EXCEPTION 'Auction draft can only start while league is setup';
  END IF;

  IF v_league.auction_budget IS NULL OR v_league.auction_budget <= 0 THEN
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

  IF EXISTS (
    SELECT 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'auction'
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
    nomination_order_mode
  )
  VALUES (
    p_league_id,
    v_season.id,
    'auction',
    'in_progress',
    v_league.auction_budget,
    now(),
    1,
    p_nomination_order_mode
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, lm.id, row_number() OVER (ORDER BY lm.joined_at ASC, lm.id ASC)::int
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  INSERT INTO draft_budgets (draft_id, member_id, initial_budget, remaining)
  SELECT v_draft.id, lm.id, v_league.auction_budget, v_league.auction_budget
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  UPDATE leagues
     SET status = 'drafting'
   WHERE id = p_league_id;

  RETURN v_draft;
END;
$$;

REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_auction_draft_atomic(uuid, text) TO service_role;

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

  IF v_nom.current_bidder_id IS NOT NULL THEN
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

    SELECT roster_size
      INTO v_roster_size
      FROM leagues
     WHERE id = v_draft.league_id
     FOR UPDATE;

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
      RAISE EXCEPTION 'Winning bidder roster is full';
    END IF;

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
