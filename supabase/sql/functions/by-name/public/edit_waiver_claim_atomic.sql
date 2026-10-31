-- Canonical SQL source for public.edit_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL,
  p_to_ir boolean DEFAULT NULL,
  p_to_taxi boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.edit_waiver_claim_atomic', jsonb_build_array(p_claim_id, p_member_id, p_user_id, p_drop_player_id, p_bid_amount, p_claim_order, p_to_ir, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_balance int;
  v_drop_failure text;
  v_lock_player_id uuid;
  v_problem_kind text;
  v_problem_message text;
BEGIN
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.league_season_id::text));

  -- Use the roster writers' lock order before any claim or league row lock.
  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(p_member_id::text));
  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id, p_drop_player_id]) AS players(player_id)
     WHERE player_id IS NOT NULL
     ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;


  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_claim.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Like create_waiver_claim_atomic, edits require eligible league/season state
  -- and add capacity. An uncleared waiver entry stays editable until processing,
  -- even after clears_at; a processed entry no longer accepts edits.
  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Waiver claims require an active, playoff, or offseason league.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_claim.league_season_id
     AND is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
    INTO v_problem_kind,v_problem_message
    FROM private.roster_problems(v_claim.league_id,v_claim.league_season_id,p_member_id) problem
    LEFT JOIN roster_players chosen ON chosen.id=problem.roster_player_id AND chosen.player_id=p_drop_player_id
   WHERE chosen.id IS NULL
   GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
  IF v_problem_kind IS NOT NULL THEN
    RAISE EXCEPTION '%',v_problem_message USING ERRCODE=CASE v_problem_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
  END IF;

  PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, p_member_id);

  IF (v_claim.process_date + time '00:00') AT TIME ZONE coalesce(v_league.timezone, 'America/Los_Angeles') <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_id=v_claim.league_id AND league_season_id=v_claim.league_season_id AND player_id=v_claim.player_id) THEN
    RAISE EXCEPTION 'This player is already on a roster.' USING ERRCODE='P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL AND p_drop_player_id = v_claim.player_id THEN
    RAISE EXCEPTION 'You cannot drop the player you are claiming.'
      USING ERRCODE = '22023';
  END IF;

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.available_faab_balance(v_claim.league_id, v_claim.league_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF COALESCE(p_to_ir,v_claim.to_ir) AND COALESCE(p_to_taxi,v_claim.to_taxi) THEN
    RAISE EXCEPTION 'Choose IR or taxi, not both.' USING ERRCODE='P0001';
  END IF;

  UPDATE waiver_claims
     SET to_ir = COALESCE(p_to_ir, to_ir),
         to_taxi = COALESCE(p_to_taxi, to_taxi),
         drop_player_id = p_drop_player_id,
         bid_amount = v_bid_amount,
         claim_order = COALESCE(p_claim_order, claim_order),
         submitted_at = now()
   WHERE id = p_claim_id;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
