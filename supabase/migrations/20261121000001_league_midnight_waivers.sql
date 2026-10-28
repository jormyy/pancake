BEGIN;
CREATE OR REPLACE FUNCTION private.next_waiver_run(p_clears_at timestamptz, p_submitted_at timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_day date := (greatest(p_clears_at, p_submitted_at) AT TIME ZONE 'America/Los_Angeles')::date;
  v_run timestamptz;
BEGIN
  v_run := (v_day + time '00:00') AT TIME ZONE 'America/Los_Angeles';
  IF v_run <= p_submitted_at OR v_run < p_clears_at THEN
    v_run := (v_day + 1 + time '00:00') AT TIME ZONE 'America/Los_Angeles';
  END IF;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
  v_waiver record; v_waiver_day date; v_waiver_due timestamptz;
  v_utc timestamp:=p_now AT TIME ZONE 'UTC'; v_key text:=date_trunc('minute',p_now)::text;
BEGIN
  PERFORM private.enqueue_close_expired_nominations(p_now);
  PERFORM private.enqueue_stats_sync_dispatch(p_now);
  PERFORM private.enqueue_process_trades(p_now);
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  PERFORM private.enqueue_matchup_forecasts(p_now);
  PERFORM private.enqueue_screen_views(p_now);
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    PERFORM private.enqueue_daily('sync-players',6,0,p_now);
    PERFORM private.enqueue_player_injuries(p_now);
    FOR v_waiver IN SELECT DISTINCT coalesce(timezone, 'America/Los_Angeles') AS timezone
      FROM public.leagues WHERE status IN ('active', 'playoffs', 'offseason') LOOP
      v_waiver_day := (p_now AT TIME ZONE v_waiver.timezone)::date;
      v_waiver_due := v_waiver_day::timestamp AT TIME ZONE v_waiver.timezone;
      PERFORM private.work_enqueue('process-waivers', v_waiver.timezone || ':' || v_waiver_day::text, v_waiver_due, jsonb_build_object('timezone', v_waiver.timezone, 'date', v_waiver_day));
    END LOOP;
    PERFORM private.enqueue_season_boundary(p_now);
    PERFORM private.enqueue_projection_sync(p_now);
    IF (p_now AT TIME ZONE 'America/New_York')::time>=time '06:20' AND EXISTS(
      SELECT 1 FROM public.nba_games WHERE game_date BETWEEN (p_now AT TIME ZONE 'America/New_York')::date-7
      AND (p_now AT TIME ZONE 'America/New_York')::date-1 AND nba_game_id LIKE '002%' AND status='Final'
    ) THEN
      PERFORM private.work_enqueue('daily-stat-corrections',(p_now AT TIME ZONE 'America/New_York')::date::text,p_now);
    END IF;
  END IF;
  IF v_min%15=5 THEN PERFORM private.enqueue_daily('sync-schedule',6,5,p_now); END IF;
  IF v_min=0 THEN PERFORM private.enqueue_rankings(p_now); END IF;
  IF v_min%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
    WHERE reconciled_at IS NULL OR worker_status='running') THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now);
  END IF;
  IF v_min=17 THEN PERFORM private.work_enqueue('pg-net-response-vacuum',date_trunc('hour',p_now)::text,p_now,'{"action":"vacuum"}'); END IF;
  IF v_min=0 AND extract(hour FROM v_utc)=13 AND
    ((extract(month FROM v_utc)=6 AND extract(day FROM v_utc)>=20) OR
     (extract(month FROM v_utc)=7 AND extract(day FROM v_utc)<=15)) THEN
    PERFORM private.work_enqueue('sync-draft-order',v_utc::date::text,p_now);
  END IF;
  IF extract(hour FROM v_utc)=8 AND v_min=35 THEN PERFORM private.work_enqueue('cleanup-trade-estimates',v_utc::date::text,p_now); END IF;
  IF extract(hour FROM v_utc)=9 AND v_min=30 THEN PERFORM private.work_enqueue('mock-room-expiry',v_utc::date::text,p_now); END IF;
  IF v_utc::time>=time '10:00' THEN
    PERFORM private.work_enqueue('retention-prune',v_utc::date::text,p_now);
  END IF;
END;
$$;

-- Canonical SQL source for public.set_waiver_clears_at.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION set_waiver_clears_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_eligible_at timestamptz := NEW.placed_on_waivers_at + interval '48 hours';
  v_run_at timestamp;
  v_timezone text;
BEGIN
  SELECT coalesce(timezone, 'America/Los_Angeles') INTO v_timezone FROM leagues WHERE id=NEW.league_id;
  v_run_at := date_trunc('day', v_eligible_at AT TIME ZONE v_timezone);
  IF v_run_at AT TIME ZONE v_timezone < v_eligible_at THEN
    v_run_at := v_run_at + interval '1 day';
  END IF;
  NEW.clears_at := v_run_at AT TIME ZONE v_timezone;
  RETURN NEW;
END;
$$;

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
  v_run_date date;
  v_run_at timestamptz;
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

  v_run_date := (greatest(v_waiver_log.clears_at, now()) AT TIME ZONE coalesce(v_league.timezone, 'America/Los_Angeles'))::date;
  v_run_at := v_run_date::timestamp AT TIME ZONE coalesce(v_league.timezone, 'America/Los_Angeles');
  IF v_run_at <= now() OR v_run_at < v_waiver_log.clears_at THEN
    v_run_date := v_run_date + 1;
  END IF;

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
    v_run_date,
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

CREATE OR REPLACE FUNCTION public.count_due_waiver_claims(p_process_date date)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer FROM public.waiver_claims candidate
  JOIN public.leagues league ON league.id=candidate.league_id AND league.status IN ('active','playoffs','offseason')
  JOIN public.league_seasons season ON season.id=candidate.league_season_id AND season.is_current
  WHERE candidate.status='pending' AND candidate.process_date<=p_process_date
    AND (candidate.process_date + time '00:00') AT TIME ZONE coalesce(league.timezone, 'America/Los_Angeles') <= now()
    AND NOT EXISTS (SELECT 1 FROM public.waiver_wire_log wire WHERE wire.league_id=candidate.league_id
      AND wire.league_season_id=candidate.league_season_id AND wire.player_id=candidate.player_id
      AND wire.cleared_at IS NULL AND wire.clears_at > (candidate.process_date + time '00:00') AT TIME ZONE coalesce(league.timezone, 'America/Los_Angeles'));
$$;

-- Canonical SQL source for public.process_next_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_to_taxi boolean := false;
  v_taxi_failure text;
BEGIN
  FOR v_candidate IN
    WITH candidate_groups AS (
      SELECT
        candidate.league_id,
        candidate.league_season_id,
        candidate.player_id,
        min(candidate.process_date) AS process_date
        FROM waiver_claims AS candidate
        JOIN leagues AS claim_league
          ON claim_league.id = candidate.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = candidate.league_season_id
         AND claim_season.is_current = true
       WHERE candidate.status = 'pending'
         AND candidate.process_date <= p_process_date
         AND (candidate.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles') <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=candidate.league_id
           AND held.league_season_id=candidate.league_season_id AND held.player_id=candidate.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (candidate.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles'))
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
        JOIN leagues AS claim_league
          ON claim_league.id = wc.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = wc.league_season_id
         AND claim_season.is_current = true
       WHERE wc.status = 'pending'
         AND wc.process_date <= p_process_date
         AND (wc.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles') <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=wc.league_id
           AND held.league_season_id=wc.league_season_id AND held.player_id=wc.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (wc.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles'))
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
         AND (wc.process_date + time '00:00') AT TIME ZONE coalesce((SELECT timezone FROM leagues WHERE id=wc.league_id), 'America/Los_Angeles') <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=wc.league_id
           AND held.league_season_id=wc.league_season_id AND held.player_id=wc.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (wc.process_date + time '00:00') AT TIME ZONE coalesce((SELECT timezone FROM leagues WHERE id=wc.league_id), 'America/Los_Angeles'))
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
        v_faab_balance := private.available_faab_balance(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
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

      SELECT string_agg(problem.message,' ' ORDER BY problem.kind,problem.player_name,problem.roster_player_id)
        INTO v_ineligible FROM private.roster_problems(v_claim.league_id,v_claim.league_season_id,v_claim.member_id) problem;
      IF v_ineligible IS NOT NULL THEN
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id,
          'failed_roster'::waiver_claim_status,v_ineligible
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

      v_to_taxi := false;
      v_taxi_failure := NULL;
      IF v_claim.to_taxi THEN
        BEGIN
          PERFORM private.authorize_taxi_acquisition(v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id,'waiver',v_claim.id);
          PERFORM private.assert_taxi_acquisition_allowed(v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id);
          v_to_taxi := true;
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          v_taxi_failure := SQLERRM;
        END;
      END IF;

      SELECT count(*)
        INTO v_active_count
        FROM roster_players AS rp
       WHERE rp.league_id = v_claim.league_id
         AND rp.league_season_id = v_claim.league_season_id
         AND rp.member_id = v_claim.member_id
         AND rp.is_on_ir = false
         AND rp.is_on_taxi = false;

      v_projected_active_count := v_active_count + CASE WHEN v_to_ir OR v_to_taxi THEN 0 ELSE 1 END - CASE WHEN v_claim.drop_player_id IS NULL OR v_to_ir OR v_to_taxi THEN 0 ELSE 1 END;

      IF NOT v_to_ir AND NOT v_to_taxi AND v_projected_active_count > COALESCE(v_roster_size, 20) THEN
        v_failure := CASE
          WHEN v_claim.to_ir THEN v_ir_failure || ' Your active roster is full.'
          WHEN v_claim.to_taxi THEN v_taxi_failure || ' Your active roster is full.'
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

      IF v_claim.drop_player_id IS NOT NULL AND NOT v_to_ir AND NOT v_to_taxi THEN
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
        is_on_ir,
        is_on_taxi
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver',
        v_to_ir,
        v_to_taxi
      );

      PERFORM private.assert_accepted_trade_capacity(v_claim.league_id,v_claim.league_season_id,v_claim.member_id);
      IF v_to_taxi THEN
        UPDATE public.notification_outbox SET body='Your waiver claim succeeded. Placed on taxi.',
          data=data || jsonb_build_object('destination','taxi','body','Your waiver claim succeeded. Placed on taxi.')
        WHERE dedupe_key='waiver_claim_won:' || v_claim.id::text || ':' || v_claim.member_id::text;
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_claim_id,
        acquired_to_taxi
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver_add',
        v_claim.id,
        v_to_taxi
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
        END || CASE WHEN v_to_taxi THEN ' Placed on taxi.' ELSE '' END,
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
    EXCEPTION WHEN SQLSTATE 'PA008' OR SQLSTATE 'PT001' THEN
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_roster'::waiver_claim_status,
        SQLERRM
      );
      RETURN;
    WHEN SQLSTATE 'PW001' OR lock_not_available THEN
      -- Release this attempt when its team, player, or league is busy.
      -- A batch can already hold a different league in the opposite order.
      CONTINUE;
    END;
  END LOOP;
END;
$$;

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

  PERFORM private.assert_legal_roster(v_claim.league_id,v_claim.league_season_id,p_member_id);

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

-- Canonical SQL source for public.reorder_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.reorder_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_direction text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result int;
BEGIN
  __request_context := private.request_begin('public.reorder_waiver_claim_atomic', jsonb_build_array(p_claim_id, p_member_id, p_user_id, p_direction), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::int; END IF;
  <<request_write>>
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_other waiver_claims%ROWTYPE;
  v_waiver_mode text;
BEGIN
  IF p_direction NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'Direction must be up or down.'
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

  IF (v_claim.process_date + time '00:00') AT TIME ZONE coalesce((SELECT timezone FROM leagues WHERE id=v_claim.league_id), 'America/Los_Angeles') <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
  END IF;

  SELECT waiver_mode INTO v_waiver_mode FROM leagues WHERE id = v_claim.league_id;

  -- Older submissions can share an order. Preserve the processor's tie order,
  -- then assign distinct positions so a requested swap always moves one claim.
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY claim_order, submitted_at, id)::int AS position
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND process_date = v_claim.process_date
       AND (v_waiver_mode = 'rolling' OR bid_amount = v_claim.bid_amount)
  )
  UPDATE waiver_claims AS claim SET claim_order = ordered.position
    FROM ordered WHERE claim.id = ordered.id AND claim.claim_order <> ordered.position;

  SELECT * INTO v_claim FROM waiver_claims WHERE id = p_claim_id;

  IF p_direction = 'up' THEN
    SELECT *
      INTO v_other
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND process_date = v_claim.process_date
       AND (v_waiver_mode = 'rolling' OR bid_amount = v_claim.bid_amount)
       AND claim_order < v_claim.claim_order
     ORDER BY claim_order DESC, submitted_at DESC
     LIMIT 1
     FOR UPDATE;
  ELSE
    SELECT *
      INTO v_other
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND process_date = v_claim.process_date
       AND (v_waiver_mode = 'rolling' OR bid_amount = v_claim.bid_amount)
       AND claim_order > v_claim.claim_order
     ORDER BY claim_order ASC, submitted_at ASC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF FOUND THEN
    UPDATE waiver_claims
       SET claim_order = v_other.claim_order
     WHERE id = v_claim.id;

    UPDATE waiver_claims
       SET claim_order = v_claim.claim_order
     WHERE id = v_other.id;

    __request_result := v_other.claim_order; EXIT request_write;
  END IF;

  __request_result := v_claim.claim_order; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.cancel_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.cancel_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.cancel_waiver_claim_atomic', jsonb_build_array(p_claim_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_status waiver_claim_status;
  v_rows int;
  v_process_date date;
BEGIN
  SELECT claim.status, claim.process_date
    INTO v_status, v_process_date
    FROM waiver_claims AS claim
    JOIN league_members AS member
      ON member.id = claim.member_id
   WHERE claim.id = p_claim_id
     AND claim.member_id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE OF claim;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'pending'::waiver_claim_status THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (v_process_date + time '00:00') AT TIME ZONE coalesce((SELECT league.timezone FROM leagues league JOIN waiver_claims claim ON claim.league_id=league.id WHERE claim.id=p_claim_id), 'America/Los_Angeles') <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
  END IF;

  UPDATE waiver_claims
     SET status = 'cancelled'::waiver_claim_status,
         processed_at = now()
   WHERE id = p_claim_id
     AND status = 'pending'::waiver_claim_status;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

WITH eligible AS (
  SELECT wire.id, wire.placed_on_waivers_at + interval '48 hours' AS eligible_at,
    coalesce(league.timezone, 'America/Los_Angeles') AS timezone
  FROM public.waiver_wire_log wire JOIN public.leagues league ON league.id=wire.league_id
  WHERE wire.cleared_at IS NULL
), scheduled AS (
  SELECT id, eligible_at, timezone, (eligible_at AT TIME ZONE timezone)::date AS day FROM eligible
)
UPDATE public.waiver_wire_log wire
SET clears_at=(scheduled.day + CASE WHEN scheduled.day::timestamp AT TIME ZONE scheduled.timezone < scheduled.eligible_at THEN 1 ELSE 0 END)::timestamp AT TIME ZONE scheduled.timezone
FROM scheduled WHERE wire.id=scheduled.id;
WITH eligible AS (
  SELECT claim.id, claim.submitted_at, coalesce(league.timezone, 'America/Los_Angeles') AS timezone,
    greatest(claim.submitted_at, max(wire.clears_at)) AS threshold
  FROM public.waiver_claims claim JOIN public.leagues league ON league.id=claim.league_id
  LEFT JOIN public.waiver_wire_log wire ON wire.league_id=claim.league_id AND wire.league_season_id=claim.league_season_id
    AND wire.player_id=claim.player_id AND wire.cleared_at IS NULL
  WHERE claim.status='pending'
  GROUP BY claim.id, league.timezone
), scheduled AS (
  SELECT *, (threshold AT TIME ZONE timezone)::date AS day FROM eligible
)
UPDATE public.waiver_claims claim
SET process_date=scheduled.day + CASE WHEN scheduled.day::timestamp AT TIME ZONE scheduled.timezone <= scheduled.submitted_at
  OR scheduled.day::timestamp AT TIME ZONE scheduled.timezone < scheduled.threshold THEN 1 ELSE 0 END
FROM scheduled WHERE claim.id=scheduled.id;
COMMIT;
