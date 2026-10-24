BEGIN;

ALTER TABLE public.waiver_claims ADD COLUMN to_ir boolean NOT NULL DEFAULT false;

DROP FUNCTION public.add_free_agent_atomic(uuid,uuid,uuid);

DROP FUNCTION public.create_waiver_claim_atomic(uuid,uuid,uuid,uuid,uuid,integer,integer);

DROP FUNCTION public.edit_waiver_claim_atomic(uuid,uuid,uuid,uuid,integer,integer);

CREATE OR REPLACE FUNCTION public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid,
  p_to_ir boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_active_count int;
  v_existing_roster_id uuid;
  v_ineligible text;
  v_ir_count int;
  v_injury text;
BEGIN
  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player - you may not have permission for this league.'
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

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_player_id::text));

  v_ineligible := private.ineligible_ir_player_names(p_league_id, v_season_id, p_member_id);
  IF v_ineligible IS NOT NULL THEN
    RAISE EXCEPTION 'You have ineligible players on IR (%). Activate or drop them before adding players.', v_ineligible
      USING ERRCODE = 'PA005';
  END IF;

  SELECT id
    INTO v_existing_roster_id
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
   FOR UPDATE;

  IF v_existing_roster_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is already on a roster.'
      USING ERRCODE = '23505';
  END IF;

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
    RAISE EXCEPTION 'Free-agent adds require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Free-agent adds require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF p_to_ir THEN
    IF v_league.status = 'offseason'::league_status THEN
      RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT injury_status INTO v_injury FROM players WHERE id = p_player_id FOR SHARE;
    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'PA006';
    END IF;
    SELECT count(*) INTO v_ir_count FROM roster_players
     WHERE member_id = p_member_id AND league_season_id = v_season_id AND is_on_ir;
    IF v_ir_count >= COALESCE(v_league.ir_slots, 2) THEN
      RAISE EXCEPTION 'Your IR slots are full (% slots).', COALESCE(v_league.ir_slots, 2)
        USING ERRCODE = 'PA007';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF NOT COALESCE(p_to_ir, false) AND v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
      USING ERRCODE = 'PA003';
  END IF;

  INSERT INTO roster_players (
    member_id,
    league_id,
    league_season_id,
    player_id,
    acquired_via,
    is_on_ir
  )
  VALUES (
    p_member_id,
    p_league_id,
    v_season_id,
    p_player_id,
    'free_agent',
    COALESCE(p_to_ir, false)
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    'fa_add'
  );

  PERFORM private.consume_weekly_add(p_league_id, v_season_id, p_member_id);

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'free_agent_added',
    'Free agent added',
    NULL,
    p_member_id,
    p_member_id,
    p_player_id,
    NULL,
    NULL,
    '{}'::jsonb
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.create_waiver_claim_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL,
  p_to_ir boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.ensure_faab_balance(p_league_id, v_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- The entry stays claimable after its window ends until the run processes
  -- it; otherwise the player could be neither claimed nor added until 3 AM ET.
  SELECT *
    INTO v_waiver_log
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
   ORDER BY clears_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on waivers.'
      USING ERRCODE = 'P0001';
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
    to_ir
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    p_drop_player_id,
    v_priority,
    (v_waiver_log.clears_at AT TIME ZONE 'America/New_York')::date,
    v_bid_amount,
    v_claim_order,
    COALESCE(p_to_ir, false)
  )
  RETURNING id INTO v_claim_id;

  RETURN v_claim_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL,
  p_to_ir boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_balance int;
  v_drop_failure text;
  v_lock_player_id uuid;
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

  PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, p_member_id);

  PERFORM 1
    FROM waiver_wire_log
   WHERE league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id
     AND player_id = v_claim.player_id
     AND cleared_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on waivers.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL AND p_drop_player_id = v_claim.player_id THEN
    RAISE EXCEPTION 'You cannot drop the player you are claiming.'
      USING ERRCODE = '22023';
  END IF;

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, p_member_id);
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

  UPDATE waiver_claims
     SET to_ir = COALESCE(p_to_ir, false),
         drop_player_id = p_drop_player_id,
         bid_amount = v_bid_amount,
         claim_order = COALESCE(p_claim_order, claim_order),
         submitted_at = now()
   WHERE id = p_claim_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.process_next_waiver_claim_atomic(
  p_process_date date
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_waiver_log_id uuid;
  v_roster_size int;
  v_active_count int;
  v_projected_active_count int;
  v_drop_roster_id uuid;
  v_max_priority int;
  v_failure text;
  v_lock_player_id uuid;
  v_target_league_id uuid;
  v_target_season_id uuid;
  v_ineligible text;
  v_faab_balance int;
  v_player_name text;
  v_candidate record;
  v_to_ir boolean := false;
  v_ir_count int;
  v_ir_eligible boolean;
  v_ir_failure text;
BEGIN
  FOR v_candidate IN
    WITH candidate_groups AS (
      SELECT
        candidate.league_id,
        candidate.league_season_id,
        candidate.player_id,
        min(candidate.process_date) AS process_date
        FROM waiver_claims AS candidate
        JOIN waiver_wire_log AS due_wwl
          ON due_wwl.league_id = candidate.league_id
         AND due_wwl.league_season_id = candidate.league_season_id
         AND due_wwl.player_id = candidate.player_id
         AND due_wwl.cleared_at IS NULL
         AND due_wwl.clears_at <= now()
        JOIN leagues AS claim_league
          ON claim_league.id = candidate.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = candidate.league_season_id
         AND claim_season.is_current = true
       WHERE candidate.status = 'pending'
         AND candidate.process_date <= p_process_date
       GROUP BY candidate.league_id, candidate.league_season_id, candidate.player_id
    ), league_candidates AS (
      SELECT DISTINCT ON (candidate_groups.league_id, candidate_groups.league_season_id)
        candidate_groups.*
        FROM candidate_groups
       ORDER BY candidate_groups.league_id, candidate_groups.league_season_id,
         candidate_groups.process_date, candidate_groups.player_id
    )
    SELECT league_candidates.league_id, league_candidates.league_season_id
      FROM league_candidates
     ORDER BY league_candidates.process_date, league_candidates.league_id,
       league_candidates.league_season_id, league_candidates.player_id
     LIMIT 128
  LOOP
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtext(v_candidate.league_id::text), hashtext(v_candidate.league_season_id::text)) THEN
        CONTINUE;
      END IF;
      v_target_league_id := v_candidate.league_id;
      v_target_season_id := v_candidate.league_season_id;

      PERFORM 1
        FROM waiver_priorities AS wp_lock
       WHERE wp_lock.league_id = v_target_league_id
         AND wp_lock.league_season_id = v_target_season_id
       ORDER BY wp_lock.priority
       FOR UPDATE;

      SELECT wc.*
        INTO v_claim
        FROM waiver_claims AS wc
        JOIN waiver_priorities AS wp
          ON wp.league_id = wc.league_id
         AND wp.league_season_id = wc.league_season_id
         AND wp.member_id = wc.member_id
        JOIN waiver_wire_log AS due_wwl
          ON due_wwl.league_id = wc.league_id
         AND due_wwl.league_season_id = wc.league_season_id
         AND due_wwl.player_id = wc.player_id
         AND due_wwl.cleared_at IS NULL
         AND due_wwl.clears_at <= now()
        JOIN leagues AS claim_league
          ON claim_league.id = wc.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = wc.league_season_id
         AND claim_season.is_current = true
       WHERE wc.status = 'pending'
         AND wc.process_date <= p_process_date
         AND wc.league_id = v_target_league_id
         AND wc.league_season_id = v_target_season_id
       ORDER BY
         wc.process_date ASC,
         CASE WHEN claim_league.waiver_mode = 'faab' THEN wc.bid_amount END DESC NULLS LAST,
         wp.priority ASC,
         wc.claim_order ASC,
         wc.submitted_at ASC,
         wc.id ASC
       LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waiver candidate changed.' USING ERRCODE = 'PW001';
      END IF;

      -- Never wait for another team while an earlier batch item retains league rows.
      -- A busy head defers its whole league; lower-priority claims cannot pass it.
      IF NOT pg_try_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.member_id::text)) THEN
        RAISE EXCEPTION 'Waiver team is busy.' USING ERRCODE = 'PW001';
      END IF;

      -- A trade can clear the pending drop while we select the candidate.
      SELECT wc.* INTO v_claim FROM waiver_claims AS wc
       WHERE wc.id = v_claim.id AND wc.status = 'pending'
         AND wc.league_id = v_target_league_id AND wc.league_season_id = v_target_season_id
         AND wc.member_id = v_claim.member_id AND wc.player_id = v_claim.player_id
         AND wc.process_date <= p_process_date
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waiver candidate changed.' USING ERRCODE = 'PW001';
      END IF;

      FOR v_lock_player_id IN
        SELECT DISTINCT pid
          FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]) AS t(pid)
         WHERE pid IS NOT NULL
         ORDER BY pid ASC
      LOOP
        IF NOT pg_try_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text)) THEN
          RAISE EXCEPTION 'Waiver player is busy.' USING ERRCODE = 'PW001';
        END IF;
      END LOOP;

      SELECT wwl.id
        INTO v_waiver_log_id
        FROM waiver_wire_log AS wwl
       WHERE wwl.league_id = v_claim.league_id
         AND wwl.league_season_id = v_claim.league_season_id
         AND wwl.player_id = v_claim.player_id
         AND wwl.cleared_at IS NULL
         AND wwl.clears_at <= now()
       ORDER BY wwl.clears_at
       LIMIT 1
       FOR UPDATE;

      IF NOT FOUND THEN
        v_failure := 'Player no longer on waivers.';
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_priority'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      SELECT *
        INTO v_league
        FROM leagues
       WHERE id = v_claim.league_id
       FOR UPDATE NOWAIT;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'League not found.'
          USING ERRCODE = 'P0002';
      END IF;

      IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
        RAISE EXCEPTION 'Waivers require an active or playoff season.'
          USING ERRCODE = 'P0001';
      END IF;

      PERFORM 1
        FROM league_seasons AS season
       WHERE season.id = v_claim.league_season_id
         AND season.is_current = true
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waivers require the current season.'
          USING ERRCODE = 'P0001';
      END IF;

      SELECT display_name
        INTO v_player_name
        FROM players
       WHERE id = v_claim.player_id;

      BEGIN
        PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
      EXCEPTION
        WHEN SQLSTATE 'PA001' THEN
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_roster'::waiver_claim_status,
            SQLERRM,
            'waiver_claim_failed_add_limit',
            'Waiver claim failed',
            jsonb_build_object('bid_amount', v_claim.bid_amount)
          );
          RETURN;
      END;

      IF v_league.waiver_mode = 'faab' THEN
        v_faab_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
        IF v_faab_balance < v_claim.bid_amount THEN
          v_failure := 'Insufficient FAAB budget for this bid.';
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_priority'::waiver_claim_status,
            v_failure,
            'faab_bid_failed',
            'FAAB bid failed',
            jsonb_build_object('bid_amount', v_claim.bid_amount)
          );
          RETURN;
        END IF;
      END IF;

      IF EXISTS (
        SELECT 1
          FROM roster_players AS rp
         WHERE rp.league_id = v_claim.league_id
           AND rp.league_season_id = v_claim.league_season_id
           AND rp.player_id = v_claim.player_id
         FOR UPDATE
      ) THEN
        v_failure := 'Player already on a roster.';
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_priority'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      v_roster_size := v_league.roster_size;

      v_ineligible := private.ineligible_ir_player_names(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
      IF v_ineligible IS NOT NULL THEN
        v_failure := format(
          'You have ineligible players on IR (%s). Activate or drop them before waiver claims can process.',
          v_ineligible
        );
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_roster'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      v_to_ir := false;
      IF v_claim.to_ir THEN
        SELECT private.is_ir_designation(injury_status) INTO v_ir_eligible
          FROM players WHERE id = v_claim.player_id FOR SHARE;
        SELECT count(*) INTO v_ir_count FROM roster_players AS ir_roster
         WHERE ir_roster.member_id = v_claim.member_id AND ir_roster.league_season_id = v_claim.league_season_id AND ir_roster.is_on_ir;
        v_ir_failure := CASE
          WHEN NOT COALESCE(v_ir_eligible, false) THEN 'Player is no longer IR eligible.'
          WHEN v_ir_count >= COALESCE(v_league.ir_slots, 2) THEN 'Your IR slots are full.'
          WHEN v_league.status = 'offseason'::league_status THEN 'IR moves are unavailable in the offseason.'
          ELSE NULL
        END;
        v_to_ir := v_ir_failure IS NULL;
      END IF;

      SELECT count(*)
        INTO v_active_count
        FROM roster_players AS rp
       WHERE rp.league_id = v_claim.league_id
         AND rp.league_season_id = v_claim.league_season_id
         AND rp.member_id = v_claim.member_id
         AND rp.is_on_ir = false
         AND rp.is_on_taxi = false;

      v_projected_active_count := v_active_count + CASE WHEN v_to_ir THEN 0 ELSE 1 END - CASE WHEN v_claim.drop_player_id IS NULL OR v_to_ir THEN 0 ELSE 1 END;

      IF NOT v_to_ir AND v_projected_active_count > COALESCE(v_roster_size, 20) THEN
        v_failure := CASE
          WHEN v_claim.to_ir THEN v_ir_failure || ' Your active roster is full.'
          WHEN v_claim.drop_player_id IS NULL THEN 'Roster full and no drop player specified.'
          ELSE 'Waiver claim would leave your active roster over the limit.'
        END;
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_roster'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      IF v_claim.drop_player_id IS NOT NULL AND NOT v_to_ir THEN
        SELECT validation.roster_player_id, validation.failure_reason
          INTO v_drop_roster_id, v_failure
          FROM private.validate_waiver_claim_drop_player(
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.drop_player_id,
            'Drop player is no longer on this active roster.'
          ) AS validation;

        IF v_failure IS NOT NULL THEN
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_roster'::waiver_claim_status,
            v_failure
          );
          RETURN;
        END IF;
      END IF;

      -- Mark the claim before the drop is released: the roster-lifecycle trigger
      -- clears stale drop selections on pending claims, and this claim's recorded
      -- drop must survive as history.
      UPDATE waiver_claims
         SET status = 'succeeded',
             processed_at = now(),
             failure_reason = NULL
       WHERE id = v_claim.id;

      IF v_drop_roster_id IS NOT NULL THEN
        PERFORM private.release_roster_player_to_waivers(
          v_drop_roster_id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.drop_player_id,
          'waiver_drop',
          v_claim.id
        );
      END IF;

      INSERT INTO roster_players (
        league_id,
        league_season_id,
        member_id,
        player_id,
        acquired_via,
        is_on_ir
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver',
        v_to_ir
      );

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_claim_id
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver_add',
        v_claim.id
      );

      UPDATE waiver_wire_log
         SET cleared_at = now(),
             claimed_by_claim_id = v_claim.id
       WHERE id = v_waiver_log_id;

      IF v_league.waiver_mode = 'faab' THEN
        UPDATE faab_balances AS balance_row
           SET balance = balance_row.balance - v_claim.bid_amount,
               updated_at = now()
         WHERE balance_row.league_id = v_claim.league_id
           AND balance_row.league_season_id = v_claim.league_season_id
           AND balance_row.member_id = v_claim.member_id;
      END IF;

      PERFORM private.consume_weekly_add(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);

      SELECT max(wp.priority)
        INTO v_max_priority
        FROM waiver_priorities AS wp
       WHERE wp.league_id = v_claim.league_id
         AND wp.league_season_id = v_claim.league_season_id;

      UPDATE waiver_priorities AS priority_row
         SET priority = COALESCE(v_max_priority, 0) + 1
       WHERE priority_row.league_id = v_claim.league_id
         AND priority_row.league_season_id = v_claim.league_season_id
         AND priority_row.member_id = v_claim.member_id;

      PERFORM private.log_league_activity(
        v_claim.league_id,
        v_claim.league_season_id,
        CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_won' ELSE 'waiver_claim_succeeded' END,
        CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid won' ELSE 'Waiver claim succeeded' END,
        COALESCE(v_player_name, 'Player') || CASE
          WHEN v_league.waiver_mode = 'faab' THEN format(' won for $%s.', v_claim.bid_amount)
          ELSE ' added from waivers.'
        END,
        NULL,
        v_claim.member_id,
        v_claim.player_id,
        NULL,
        v_claim.id,
        jsonb_build_object('bid_amount', v_claim.bid_amount, 'waiver_mode', v_league.waiver_mode)
      );

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;

      RETURN QUERY
      WITH failed AS (
        UPDATE waiver_claims AS wc_other
           SET status = 'failed_priority',
               processed_at = now(),
               failure_reason = CASE
                 WHEN v_league.waiver_mode = 'faab' THEN 'Claimed by a higher FAAB bid or tiebreaker.'
                 ELSE 'Claimed by higher-priority team.'
               END
         WHERE wc_other.status = 'pending'
           AND wc_other.league_id = v_claim.league_id
           AND wc_other.league_season_id = v_claim.league_season_id
           AND wc_other.player_id = v_claim.player_id
           AND wc_other.id <> v_claim.id
         RETURNING wc_other.id, wc_other.member_id, wc_other.player_id, wc_other.status, wc_other.failure_reason, wc_other.bid_amount
      ),
      logged AS (
        INSERT INTO league_activity (
          league_id,
          league_season_id,
          target_member_id,
          related_player_id,
          related_claim_id,
          event_type,
          title,
          body,
          metadata
        )
        SELECT
          v_claim.league_id,
          v_claim.league_season_id,
          failed.member_id,
          failed.player_id,
          failed.id,
          CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_lost' ELSE 'waiver_claim_failed_priority' END,
          CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid lost' ELSE 'Waiver claim failed' END,
          failed.failure_reason,
          jsonb_build_object('bid_amount', failed.bid_amount, 'winning_bid_amount', v_claim.bid_amount)
        FROM failed
        RETURNING id
      )
      SELECT true, failed.id, failed.member_id, failed.player_id, failed.status, failed.failure_reason
        FROM failed;
      RETURN;
    EXCEPTION WHEN SQLSTATE 'PW001' OR lock_not_available THEN
      -- Release this attempt when its team, player, or league is busy.
      -- A batch can already hold a different league in the opposite order.
      CONTINUE;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_league_projection_rows(
  p_league_id uuid,
  p_season_year int DEFAULT public.current_season_year_et(),
  p_game_date date DEFAULT (timezone('America/New_York', now()))::date,
  p_view text DEFAULT 'today',
  p_player_ids uuid[] DEFAULT NULL,
  p_limit int DEFAULT 600,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  player_id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  injury_status text,
  headshot_url text,
  nba_id text,
  next_game_date date,
  next_game_opponent text,
  next_game_time timestamptz,
  projection_source text,
  projection_source_label text,
  projection_view text,
  projection_fantasy_points numeric,
  projection_minutes numeric,
  projection_points numeric,
  projection_rebounds numeric,
  projection_assists numeric,
  projection_steals numeric,
  projection_blocks numeric,
  projection_three_pointers_made numeric,
  projection_turnovers numeric,
  projection_games_played int,
  projection_field_goal_pct numeric,
  projection_free_throw_pct numeric,
  projection_status text,
  projection_fetched_at timestamptz,
  projection_date date,
  projection_week_number int,
  projection_is_fresh boolean
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH args AS (
  SELECT
    CASE WHEN p_view IN ('today', 'week_avg', 'week_total') THEN p_view ELSE 'today' END AS view_name,
    COALESCE(p_game_date, (timezone('America/New_York', now()))::date) AS game_date,
    LEAST(GREATEST(COALESCE(p_limit, 600), 1), 1000) AS page_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS page_offset
),
league AS (
  SELECT
    id,
    scoring_settings,
    (
      COALESCE((scoring_settings->>'field_goals_made')::numeric, 0) <> 0 OR
      COALESCE((scoring_settings->>'field_goals_attempted')::numeric, 0) <> 0 OR
      COALESCE((scoring_settings->>'free_throws_made')::numeric, 0) <> 0 OR
      COALESCE((scoring_settings->>'free_throws_attempted')::numeric, 0) <> 0
    ) AS uses_fantasypros_unsupported_scoring
  FROM public.leagues
  WHERE id = p_league_id
),
week_ctx AS (
  SELECT sw.week_number, sw.week_start, sw.week_end
  FROM args
  JOIN public.season_weeks sw
    ON sw.season_year = p_season_year
   AND sw.week_start <= args.game_date
   AND sw.week_end >= args.game_date
  LIMIT 1
),
base_players AS (
  SELECT
    p.id,
    COALESCE(p.display_name, concat_ws(' ', p.first_name, p.last_name)) AS display_name,
    p.nba_team,
    p.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(p.eligible_positions) AS pos) AS eligible_positions,
    p.injury_status,
    p.headshot_url,
    p.nba_id
  FROM public.players p
  WHERE p_player_ids IS NULL OR p.id = ANY(p_player_ids)
),
team_next_games AS MATERIALIZED (
  SELECT teams.nba_team, g.game_date, g.home_team, g.away_team, g.game_time
  FROM (SELECT DISTINCT nba_team FROM base_players WHERE nba_team IS NOT NULL) teams
  LEFT JOIN LATERAL (
    SELECT ng.game_date, ng.home_team, ng.away_team, ng.game_time
    FROM args
    JOIN public.nba_games ng
      ON ng.season_year = p_season_year
     AND ng.game_date >= args.game_date
     AND ng.status NOT IN ('InProgress', 'Final')
     AND (ng.game_time IS NULL OR ng.game_time > now())
     AND (ng.started_at IS NULL OR ng.started_at > now())
     AND public.is_regular_season_game_id(ng.nba_game_id)
     AND (ng.home_team = teams.nba_team OR ng.away_team = teams.nba_team)
    ORDER BY ng.game_date ASC, ng.game_time ASC NULLS LAST, ng.id ASC
    LIMIT 1
  ) g ON true
),
next_games AS (
  SELECT
    bp.id AS player_id,
    g.game_date AS next_game_date,
    CASE
      WHEN g.home_team = bp.nba_team THEN 'vs ' || COALESCE(g.away_team, '?')
      WHEN g.away_team = bp.nba_team THEN '@ ' || COALESCE(g.home_team, '?')
      ELSE NULL
    END AS next_game_opponent,
    g.game_time AS next_game_time
  FROM base_players bp
  LEFT JOIN team_next_games g ON g.nba_team = bp.nba_team
),
week_game_counts AS (
  SELECT
    bp.id AS player_id,
    COUNT(ng.id)::int AS scheduled_games
  FROM base_players bp
  JOIN week_ctx wc ON true
  JOIN public.nba_games ng
    ON ng.season_year = p_season_year
   AND ng.week_number = wc.week_number
   AND public.is_regular_season_game_id(ng.nba_game_id)
   AND bp.nba_team IS NOT NULL
   AND (ng.home_team = bp.nba_team OR ng.away_team = bp.nba_team)
  GROUP BY bp.id
),
latest_daily_run AS (
  SELECT latest_run.id
  FROM args
  JOIN public.projection_sync_runs latest_run
    ON latest_run.source = 'fantasypros'
   AND latest_run.projection_type = 'daily'
   AND latest_run.projection_date = args.game_date
   AND latest_run.status = 'success'
   AND latest_run.completed_at IS NOT NULL
  ORDER BY latest_run.started_at DESC, latest_run.id DESC
  LIMIT 1
),
latest_weekly_avg_run AS (
  SELECT latest_run.id
  FROM args
  LEFT JOIN week_ctx wc ON true
  JOIN public.projection_sync_runs latest_run
    ON latest_run.source = 'fantasypros'
   AND latest_run.projection_type = 'weekly_avg'
   AND latest_run.season_year = p_season_year
   AND (wc.week_number IS NULL OR latest_run.week_number IS NULL OR latest_run.week_number = wc.week_number)
   AND latest_run.status = 'success'
   AND latest_run.completed_at IS NOT NULL
  ORDER BY latest_run.week_number DESC NULLS LAST, latest_run.started_at DESC, latest_run.id DESC
  LIMIT 1
),
latest_weekly_total_run AS (
  SELECT latest_run.id
  FROM args
  LEFT JOIN week_ctx wc ON true
  JOIN public.projection_sync_runs latest_run
    ON latest_run.source = 'fantasypros'
   AND latest_run.projection_type = 'weekly_total'
   AND latest_run.season_year = p_season_year
   AND (wc.week_number IS NULL OR latest_run.week_number IS NULL OR latest_run.week_number = wc.week_number)
   AND latest_run.status = 'success'
   AND latest_run.completed_at IS NOT NULL
  ORDER BY latest_run.week_number DESC NULLS LAST, latest_run.started_at DESC, latest_run.id DESC
  LIMIT 1
),
daily_candidates AS (
  SELECT DISTINCT ON (r.player_id)
    r.player_id,
    'fantasypros_daily'::text AS projection_source,
    'FantasyPros Daily'::text AS projection_source_label,
    'today'::text AS projection_view,
    public.projection_stat_fantasy_points(
      r.points, r.rebounds, r.assists, r.steals, r.blocks, r.three_pointers_made, r.turnovers,
      NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
      l.scoring_settings
    ) AS projection_fantasy_points,
    r.minutes AS projection_minutes,
    r.points AS projection_points,
    r.rebounds AS projection_rebounds,
    r.assists AS projection_assists,
    r.steals AS projection_steals,
    r.blocks AS projection_blocks,
    r.three_pointers_made AS projection_three_pointers_made,
    r.turnovers AS projection_turnovers,
    r.games_played AS projection_games_played,
    r.field_goal_pct AS projection_field_goal_pct,
    r.free_throw_pct AS projection_free_throw_pct,
    r.source_status AS projection_status,
    r.fetched_at AS projection_fetched_at,
    r.projection_date,
    r.week_number AS projection_week_number,
    true AS projection_is_fresh,
    1 AS priority
  FROM args
  JOIN league l ON true
  JOIN public.fantasypros_projection_rows r
    ON r.projection_type = 'daily'
   AND r.match_status = 'matched'
   AND r.player_id IS NOT NULL
   AND r.projection_date = args.game_date
   AND r.fetched_at >= now() - interval '36 hours'
  JOIN latest_daily_run ldr
    ON ldr.id = r.run_id
  JOIN base_players projected_player
    ON projected_player.id = r.player_id
  JOIN public.projection_sync_runs psr
    ON psr.id = r.run_id
   AND psr.status = 'success'
   AND psr.completed_at IS NOT NULL
  WHERE args.view_name = 'today'
    AND NOT l.uses_fantasypros_unsupported_scoring
  ORDER BY r.player_id, r.fetched_at DESC, r.run_id DESC
),
weekly_avg_candidates AS (
  SELECT DISTINCT ON (r.player_id)
    r.player_id,
    CASE
      WHEN args.view_name = 'week_total' THEN 'fantasypros_weekly_avg_total'
      ELSE 'fantasypros_weekly_avg'
    END::text AS projection_source,
    CASE
      WHEN args.view_name = 'week_total' THEN 'FantasyPros Week Avg x GP'
      ELSE 'FantasyPros Week Avg'
    END::text AS projection_source_label,
    CASE
      WHEN args.view_name = 'week_total' THEN 'week_total'
      ELSE 'week_avg'
    END::text AS projection_view,
    public.projection_stat_fantasy_points(
      r.points * m.games_multiplier,
      r.rebounds * m.games_multiplier,
      r.assists * m.games_multiplier,
      r.steals * m.games_multiplier,
      r.blocks * m.games_multiplier,
      r.three_pointers_made * m.games_multiplier,
      r.turnovers * m.games_multiplier,
      NULL::numeric,
      NULL::numeric,
      NULL::numeric,
      NULL::numeric,
      CASE
        WHEN args.view_name = 'week_total' AND m.games_multiplier > 0 AND (
          (COALESCE(r.points, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) >= 10)::int +
          (COALESCE(r.assists, 0) >= 10)::int +
          (COALESCE(r.steals, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) >= 10)::int
        ) >= 2 THEN m.games_multiplier
        WHEN args.view_name = 'week_total' THEN 0::numeric
        ELSE NULL::numeric
      END,
      CASE
        WHEN args.view_name = 'week_total' AND m.games_multiplier > 0 AND (
          (COALESCE(r.points, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) >= 10)::int +
          (COALESCE(r.assists, 0) >= 10)::int +
          (COALESCE(r.steals, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) >= 10)::int
        ) >= 3 THEN m.games_multiplier
        WHEN args.view_name = 'week_total' THEN 0::numeric
        ELSE NULL::numeric
      END,
      l.scoring_settings
    ) AS projection_fantasy_points,
    r.minutes * m.games_multiplier AS projection_minutes,
    r.points * m.games_multiplier AS projection_points,
    r.rebounds * m.games_multiplier AS projection_rebounds,
    r.assists * m.games_multiplier AS projection_assists,
    r.steals * m.games_multiplier AS projection_steals,
    r.blocks * m.games_multiplier AS projection_blocks,
    r.three_pointers_made * m.games_multiplier AS projection_three_pointers_made,
    r.turnovers * m.games_multiplier AS projection_turnovers,
    CASE WHEN args.view_name = 'week_total' THEN m.games_multiplier::int ELSE r.games_played END AS projection_games_played,
    r.field_goal_pct AS projection_field_goal_pct,
    r.free_throw_pct AS projection_free_throw_pct,
    r.source_status AS projection_status,
    r.fetched_at AS projection_fetched_at,
    r.projection_date,
    r.week_number AS projection_week_number,
    true AS projection_is_fresh,
    CASE WHEN args.view_name = 'week_avg' THEN 1 ELSE 2 END AS priority
  FROM args
  JOIN league l ON true
  LEFT JOIN week_ctx wc ON true
  JOIN public.fantasypros_projection_rows r
    ON r.projection_type = 'weekly_avg'
   AND r.match_status = 'matched'
   AND r.player_id IS NOT NULL
   AND r.season_year = p_season_year
   AND (wc.week_number IS NULL OR r.week_number IS NULL OR r.week_number = wc.week_number)
   AND r.fetched_at >= now() - interval '8 days'
  JOIN latest_weekly_avg_run lwar
    ON lwar.id = r.run_id
  JOIN base_players projected_player
    ON projected_player.id = r.player_id
  JOIN public.projection_sync_runs psr
    ON psr.id = r.run_id
   AND psr.status = 'success'
   AND psr.completed_at IS NOT NULL
  LEFT JOIN week_game_counts wgc
    ON wgc.player_id = r.player_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN args.view_name = 'week_total' THEN COALESCE(NULLIF(r.games_played, 0), wgc.scheduled_games, 0)::numeric
      ELSE 1::numeric
    END AS games_multiplier
  ) m
  WHERE args.view_name IN ('today', 'week_avg', 'week_total')
    AND NOT l.uses_fantasypros_unsupported_scoring
  ORDER BY r.player_id, r.week_number DESC NULLS LAST, r.fetched_at DESC, r.run_id DESC
),
weekly_total_candidates AS (
  SELECT DISTINCT ON (r.player_id)
    r.player_id,
    'fantasypros_weekly_total'::text AS projection_source,
    'FantasyPros Week Total'::text AS projection_source_label,
    'week_total'::text AS projection_view,
    public.projection_stat_fantasy_points(
      r.points, r.rebounds, r.assists, r.steals, r.blocks, r.three_pointers_made, r.turnovers,
      NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
      CASE
        WHEN COALESCE(r.games_played, 0) > 0 AND (
          (COALESCE(r.points, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.assists, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.steals, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) / NULLIF(r.games_played, 0) >= 10)::int
        ) >= 2 THEN r.games_played::numeric
        ELSE 0
      END,
      CASE
        WHEN COALESCE(r.games_played, 0) > 0 AND (
          (COALESCE(r.points, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.assists, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.steals, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) / NULLIF(r.games_played, 0) >= 10)::int
        ) >= 3 THEN r.games_played::numeric
        ELSE 0
      END,
      l.scoring_settings
    ) AS projection_fantasy_points,
    r.minutes AS projection_minutes,
    r.points AS projection_points,
    r.rebounds AS projection_rebounds,
    r.assists AS projection_assists,
    r.steals AS projection_steals,
    r.blocks AS projection_blocks,
    r.three_pointers_made AS projection_three_pointers_made,
    r.turnovers AS projection_turnovers,
    r.games_played AS projection_games_played,
    r.field_goal_pct AS projection_field_goal_pct,
    r.free_throw_pct AS projection_free_throw_pct,
    r.source_status AS projection_status,
    r.fetched_at AS projection_fetched_at,
    r.projection_date,
    r.week_number AS projection_week_number,
    true AS projection_is_fresh,
    1 AS priority
  FROM args
  JOIN league l ON true
  LEFT JOIN week_ctx wc ON true
  JOIN public.fantasypros_projection_rows r
    ON r.projection_type = 'weekly_total'
   AND r.match_status = 'matched'
   AND r.player_id IS NOT NULL
   AND r.season_year = p_season_year
   AND (wc.week_number IS NULL OR r.week_number IS NULL OR r.week_number = wc.week_number)
   AND r.fetched_at >= now() - interval '8 days'
  JOIN latest_weekly_total_run lwtr
    ON lwtr.id = r.run_id
  JOIN base_players projected_player
    ON projected_player.id = r.player_id
  JOIN public.projection_sync_runs psr
    ON psr.id = r.run_id
   AND psr.status = 'success'
   AND psr.completed_at IS NOT NULL
  WHERE args.view_name = 'week_total'
    AND NOT l.uses_fantasypros_unsupported_scoring
  ORDER BY r.player_id, r.week_number DESC NULLS LAST, r.fetched_at DESC, r.run_id DESC
),
internal_candidates AS (
  SELECT DISTINCT ON (pp.player_id)
    pp.player_id,
    'internal'::text AS projection_source,
    'Internal Projection'::text AS projection_source_label,
    'fallback'::text AS projection_view,
    public.projection_stat_fantasy_points(
      pp.projected_stat_points * m.games_multiplier,
      pp.projected_rebounds * m.games_multiplier,
      pp.projected_assists * m.games_multiplier,
      pp.projected_steals * m.games_multiplier,
      pp.projected_blocks * m.games_multiplier,
      pp.projected_three_pointers_made * m.games_multiplier,
      pp.projected_turnovers * m.games_multiplier,
      pp.projected_field_goals_made * m.games_multiplier,
      pp.projected_field_goals_attempted * m.games_multiplier,
      pp.projected_free_throws_made * m.games_multiplier,
      pp.projected_free_throws_attempted * m.games_multiplier,
      CASE
        WHEN args.view_name = 'week_total' THEN COALESCE(pp.projected_double_doubles, 0) * m.games_multiplier
        ELSE pp.projected_double_doubles
      END,
      CASE
        WHEN args.view_name = 'week_total' THEN COALESCE(pp.projected_triple_doubles, 0) * m.games_multiplier
        ELSE pp.projected_triple_doubles
      END,
      l.scoring_settings
    ) AS projection_fantasy_points,
    pp.projected_minutes * m.games_multiplier AS projection_minutes,
    pp.projected_stat_points * m.games_multiplier AS projection_points,
    pp.projected_rebounds * m.games_multiplier AS projection_rebounds,
    pp.projected_assists * m.games_multiplier AS projection_assists,
    pp.projected_steals * m.games_multiplier AS projection_steals,
    pp.projected_blocks * m.games_multiplier AS projection_blocks,
    pp.projected_three_pointers_made * m.games_multiplier AS projection_three_pointers_made,
    pp.projected_turnovers * m.games_multiplier AS projection_turnovers,
    CASE WHEN args.view_name = 'week_total' THEN m.games_multiplier::int ELSE NULL::int END AS projection_games_played,
    NULL::numeric AS projection_field_goal_pct,
    NULL::numeric AS projection_free_throw_pct,
    NULL::text AS projection_status,
    pp.fetched_at AS projection_fetched_at,
    NULL::date AS projection_date,
    pp.week_number AS projection_week_number,
    true AS projection_is_fresh,
    3 AS priority
  FROM args
  JOIN week_ctx wc ON true
  JOIN league l ON true
  JOIN public.player_projections pp
    ON pp.season_year = p_season_year
   AND pp.week_number = wc.week_number
   AND pp.projected_stat_points IS NOT NULL
  JOIN base_players projected_player
    ON projected_player.id = pp.player_id
  LEFT JOIN week_game_counts wgc
    ON wgc.player_id = pp.player_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN args.view_name = 'week_total' THEN COALESCE(wgc.scheduled_games, 0)::numeric
      ELSE 1::numeric
    END AS games_multiplier
  ) m
  ORDER BY pp.player_id, pp.fetched_at DESC
),
season_avg_candidates AS (
  SELECT
    avg.player_id,
    'season_avg'::text AS projection_source,
    'Season Avg'::text AS projection_source_label,
    'fallback'::text AS projection_view,
    public.projection_stat_fantasy_points(
      avg.avg_points * m.games_multiplier,
      avg.avg_rebounds * m.games_multiplier,
      avg.avg_assists * m.games_multiplier,
      avg.avg_steals * m.games_multiplier,
      avg.avg_blocks * m.games_multiplier,
      avg.avg_three_pointers_made * m.games_multiplier,
      avg.avg_turnovers * m.games_multiplier,
      avg.avg_field_goals_made * m.games_multiplier,
      avg.avg_field_goals_attempted * m.games_multiplier,
      avg.avg_free_throws_made * m.games_multiplier,
      avg.avg_free_throws_attempted * m.games_multiplier,
      (CASE WHEN COALESCE(avg.games_played, 0) > 0
        THEN COALESCE(avg.double_doubles, 0)::numeric / avg.games_played
        ELSE 0 END) * m.games_multiplier,
      (CASE WHEN COALESCE(avg.games_played, 0) > 0
        THEN COALESCE(avg.triple_doubles, 0)::numeric / avg.games_played
        ELSE 0 END) * m.games_multiplier,
      l.scoring_settings
    ) AS projection_fantasy_points,
    avg.avg_minutes_played * m.games_multiplier AS projection_minutes,
    avg.avg_points * m.games_multiplier AS projection_points,
    avg.avg_rebounds * m.games_multiplier AS projection_rebounds,
    avg.avg_assists * m.games_multiplier AS projection_assists,
    avg.avg_steals * m.games_multiplier AS projection_steals,
    avg.avg_blocks * m.games_multiplier AS projection_blocks,
    avg.avg_three_pointers_made * m.games_multiplier AS projection_three_pointers_made,
    avg.avg_turnovers * m.games_multiplier AS projection_turnovers,
    CASE WHEN args.view_name = 'week_total' THEN m.games_multiplier::int ELSE avg.games_played::int END AS projection_games_played,
    NULL::numeric AS projection_field_goal_pct,
    NULL::numeric AS projection_free_throw_pct,
    NULL::text AS projection_status,
    NULL::timestamptz AS projection_fetched_at,
    NULL::date AS projection_date,
    NULL::int AS projection_week_number,
    true AS projection_is_fresh,
    4 AS priority
  FROM args
  JOIN league l ON true
  JOIN public.mv_player_season_averages avg
    ON avg.season_year = p_season_year
  JOIN base_players projected_player
    ON projected_player.id = avg.player_id
  LEFT JOIN week_game_counts wgc
    ON wgc.player_id = avg.player_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN args.view_name = 'week_total' THEN COALESCE(wgc.scheduled_games, 0)::numeric
      ELSE 1::numeric
    END AS games_multiplier
  ) m
),
candidate_union AS (
  SELECT * FROM daily_candidates
  UNION ALL SELECT * FROM weekly_total_candidates
  UNION ALL SELECT * FROM weekly_avg_candidates
  UNION ALL SELECT * FROM internal_candidates
  UNION ALL SELECT * FROM season_avg_candidates
),
fallback_best AS (
  SELECT DISTINCT ON (cu.player_id) cu.*
  FROM candidate_union cu
  ORDER BY cu.player_id, cu.priority ASC, cu.projection_fetched_at DESC NULLS LAST
),
sleeper_games AS (
  SELECT r.*, public.projection_stat_fantasy_points(
    r.points, r.rebounds, r.assists, r.steals, r.blocks, r.three_pointers_made, r.turnovers,
    r.field_goals_made, r.field_goals_attempted, r.free_throws_made, r.free_throws_attempted,
    r.double_doubles, r.triple_doubles, l.scoring_settings
  ) AS fantasy_points, r.team IS DISTINCT FROM bp.nba_team AS prior_team_game
  FROM public.sleeper_projection_rows r
  JOIN base_players bp ON bp.id = r.player_id
  LEFT JOIN next_games ng ON ng.player_id=bp.id
  JOIN league l ON true
  CROSS JOIN args
  LEFT JOIN week_ctx wc ON true
  WHERE r.season_year = p_season_year
    AND (r.game_date<(now() AT TIME ZONE 'America/New_York')::date OR r.team=bp.nba_team)
    AND EXISTS (SELECT 1 FROM public.nba_games g WHERE g.season_year=p_season_year
      AND g.game_date=r.game_date AND public.is_regular_season_game_id(g.nba_game_id)
      AND (g.home_team=r.team AND g.away_team=r.opponent OR g.away_team=r.team AND g.home_team=r.opponent))
    AND (args.view_name = 'today' AND r.game_date = COALESCE(ng.next_game_date,args.game_date)
      OR args.view_name <> 'today' AND r.week_number = wc.week_number)
),
sleeper_totals AS (
  SELECT player_id, count(*)::integer AS games, count(*) FILTER(WHERE prior_team_game)::integer AS prior_team_games,
    sum(fantasy_points) AS fantasy_points,
    sum(points) AS points, sum(rebounds) AS rebounds, sum(assists) AS assists,
    sum(steals) AS steals, sum(blocks) AS blocks, sum(three_pointers_made) AS three_pointers_made,
    sum(turnovers) AS turnovers, sum(minutes) AS minutes,
    100 * sum(field_goals_made) / NULLIF(sum(field_goals_attempted),0) AS field_goal_pct,
    100 * sum(free_throws_made) / NULLIF(sum(free_throws_attempted),0) AS free_throw_pct,
    max(fetched_at) AS fetched_at, min(game_date) AS game_date, min(week_number) AS week_number
  FROM sleeper_games GROUP BY player_id
),
sleeper_candidates AS (
  SELECT s.player_id, 'sleeper'::text AS projection_source, 'Sleeper (RotoWire)'::text AS projection_source_label,
    args.view_name AS projection_view,
    ROUND((s.fantasy_points + COALESCE(b.projection_fantasy_points * m.missing_fraction,0)) / m.divisor,2) AS projection_fantasy_points,
    (s.minutes + COALESCE(b.projection_minutes * m.missing_fraction,0)) / m.divisor AS projection_minutes,
    (s.points + COALESCE(b.projection_points * m.missing_fraction,0)) / m.divisor AS projection_points,
    (s.rebounds + COALESCE(b.projection_rebounds * m.missing_fraction,0)) / m.divisor AS projection_rebounds,
    (s.assists + COALESCE(b.projection_assists * m.missing_fraction,0)) / m.divisor AS projection_assists,
    (s.steals + COALESCE(b.projection_steals * m.missing_fraction,0)) / m.divisor AS projection_steals,
    (s.blocks + COALESCE(b.projection_blocks * m.missing_fraction,0)) / m.divisor AS projection_blocks,
    (s.three_pointers_made + COALESCE(b.projection_three_pointers_made * m.missing_fraction,0)) / m.divisor AS projection_three_pointers_made,
    (s.turnovers + COALESCE(b.projection_turnovers * m.missing_fraction,0)) / m.divisor AS projection_turnovers,
    s.games + CASE WHEN b.player_id IS NOT NULL THEN m.missing_games ELSE 0 END AS projection_games_played,
    (COALESCE(s.field_goal_pct,0)*s.games + COALESCE(b.projection_field_goal_pct,0)*m.missing_games) /
      NULLIF(s.games + CASE WHEN b.projection_field_goal_pct IS NOT NULL THEN m.missing_games ELSE 0 END,0) AS projection_field_goal_pct,
    (COALESCE(s.free_throw_pct,0)*s.games + COALESCE(b.projection_free_throw_pct,0)*m.missing_games) /
      NULLIF(s.games + CASE WHEN b.projection_free_throw_pct IS NOT NULL THEN m.missing_games ELSE 0 END,0) AS projection_free_throw_pct,
    NULL::text AS projection_status, s.fetched_at AS projection_fetched_at,
    CASE WHEN args.view_name='today' THEN s.game_date ELSE NULL::date END AS projection_date,
    s.week_number AS projection_week_number, s.fetched_at>=now()-interval '36 hours' AS projection_is_fresh, 0 AS priority
  FROM sleeper_totals s CROSS JOIN args
  LEFT JOIN fallback_best b ON b.player_id=s.player_id
  LEFT JOIN week_game_counts wgc ON wgc.player_id=s.player_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN args.view_name='today' THEN 0 ELSE GREATEST(COALESCE(wgc.scheduled_games,0)+s.prior_team_games-s.games,0) END AS missing_games
  ) missing
  CROSS JOIN LATERAL (
    SELECT missing.missing_games,
      CASE WHEN args.view_name='week_total' THEN missing.missing_games::numeric / NULLIF(b.projection_games_played,0)
        ELSE missing.missing_games::numeric END AS missing_fraction,
      CASE WHEN args.view_name='week_avg' THEN s.games + CASE WHEN b.player_id IS NOT NULL THEN missing.missing_games ELSE 0 END
        ELSE 1 END::numeric AS divisor
  ) m
),
best AS (
  SELECT * FROM sleeper_candidates
  UNION ALL SELECT b.* FROM fallback_best b WHERE NOT EXISTS(SELECT 1 FROM sleeper_candidates s WHERE s.player_id=b.player_id)
)

SELECT
  bp.id AS player_id,
  bp.display_name,
  bp.nba_team,
  bp."position",
  bp.eligible_positions,
  bp.injury_status,
  bp.headshot_url,
  bp.nba_id,
  ng.next_game_date,
  ng.next_game_opponent,
  ng.next_game_time,
  b.projection_source,
  b.projection_source_label,
  b.projection_view,
  b.projection_fantasy_points,
  b.projection_minutes,
  b.projection_points,
  b.projection_rebounds,
  b.projection_assists,
  b.projection_steals,
  b.projection_blocks,
  b.projection_three_pointers_made,
  b.projection_turnovers,
  b.projection_games_played,
  b.projection_field_goal_pct,
  b.projection_free_throw_pct,
  b.projection_status,
  b.projection_fetched_at,
  COALESCE(b.projection_date, ng.next_game_date) AS projection_date,
  b.projection_week_number,
  b.projection_is_fresh
FROM args
JOIN base_players bp ON true
LEFT JOIN best b ON b.player_id = bp.id
LEFT JOIN next_games ng ON ng.player_id = bp.id
WHERE b.player_id IS NOT NULL
ORDER BY b.projection_fantasy_points DESC NULLS LAST, bp.display_name ASC, bp.id ASC
LIMIT (SELECT page_limit FROM args)
OFFSET (SELECT page_offset FROM args);
$$;


REVOKE ALL ON FUNCTION public.add_free_agent_atomic(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.add_free_agent_atomic(uuid,uuid,uuid,boolean) TO authenticated,service_role;

REVOKE ALL ON FUNCTION public.create_waiver_claim_atomic(uuid,uuid,uuid,uuid,uuid,integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.create_waiver_claim_atomic(uuid,uuid,uuid,uuid,uuid,integer,integer,boolean) TO service_role;

REVOKE ALL ON FUNCTION public.edit_waiver_claim_atomic(uuid,uuid,uuid,uuid,integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.edit_waiver_claim_atomic(uuid,uuid,uuid,uuid,integer,integer,boolean) TO service_role;

COMMIT;
