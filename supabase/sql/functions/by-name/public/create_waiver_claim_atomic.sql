-- Canonical SQL source for public.create_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.create_waiver_claim_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL,
  p_to_ir boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
BEGIN
  __request_context := private.request_begin('public.create_waiver_claim_atomic', jsonb_build_array(p_league_id, p_member_id, p_player_id, p_drop_player_id, p_user_id, p_bid_amount, p_claim_order, p_to_ir, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_priority int;
  v_waiver_log waiver_wire_log%ROWTYPE;
  v_claim_id uuid;
  v_lock_player_id uuid;
  v_drop_failure text;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_claim_order int;
  v_balance int;
BEGIN
  IF p_to_ir AND p_to_taxi THEN
    RAISE EXCEPTION 'Choose IR or taxi, not both.' USING ERRCODE='P0001';
  END IF;
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND (p_user_id IS NULL OR user_id = p_user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_season_id::text));

  SELECT priority
    INTO v_priority
    FROM waiver_priorities
   WHERE member_id = p_member_id
     AND league_season_id = v_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No waiver priority found for your team.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));

  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(ARRAY[p_player_id, p_drop_player_id]::uuid[]) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Waiver claims require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_season_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_legal_roster(p_league_id,v_season_id,p_member_id);

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.available_faab_balance(p_league_id, v_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT *
    INTO v_waiver_log
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
   ORDER BY clears_at DESC
   LIMIT 1
   FOR UPDATE;

  IF EXISTS (SELECT 1 FROM roster_players WHERE league_id=p_league_id AND league_season_id=v_season_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player is already on a roster.' USING ERRCODE = 'P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        p_league_id,
        v_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_season_id
       AND player_id = p_player_id
       AND status = 'pending'
     FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'You already have a pending claim for this player.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(p_claim_order, max(claim_order) + 1, 1)
    INTO v_claim_order
    FROM waiver_claims
   WHERE member_id = p_member_id
     AND league_season_id = v_season_id
     AND status = 'pending';

  INSERT INTO waiver_claims (
    league_id,
    league_season_id,
    member_id,
    player_id,
    drop_player_id,
    priority_at_submission,
    process_date,
    bid_amount,
    claim_order,
    to_ir,
    to_taxi
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    p_drop_player_id,
    v_priority,
    (private.next_waiver_run(v_waiver_log.clears_at, now()) AT TIME ZONE 'America/New_York')::date,
    v_bid_amount,
    v_claim_order,
    COALESCE(p_to_ir, false),
    COALESCE(p_to_taxi, false)
  )
  RETURNING id INTO v_claim_id;

  __request_result := v_claim_id; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
