CREATE OR REPLACE FUNCTION private.trade_hold_roster(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_trade_ids uuid[],
  p_extra jsonb DEFAULT NULL
)
RETURNS TABLE(player_id uuid, on_ir boolean, on_taxi boolean)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH commitments AS (
    SELECT trade.id, participant.drop_player_ids, participant.roster_moves
      FROM trades trade
      JOIN trade_participants participant
        ON participant.trade_id = trade.id
       AND participant.member_id = p_member_id
     WHERE trade.id = ANY(p_trade_ids)
  ), extra_drop AS (
    SELECT value::uuid AS player_id
      FROM jsonb_array_elements_text(COALESCE(p_extra->'dropPlayerIds', '[]'::jsonb)) value
     WHERE value IS NOT NULL
  ), retained AS (
    SELECT roster.player_id,
      CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination' = 'ir' END AS on_ir,
      CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE move.value->>'destination' = 'taxi' END AS on_taxi
      FROM roster_players roster
      LEFT JOIN LATERAL (
        SELECT value
          FROM commitments, jsonb_array_elements(commitments.roster_moves)
         WHERE value->>'playerId' = roster.player_id::text
         LIMIT 1
      ) move ON true
     WHERE roster.league_season_id = p_season_id
       AND roster.member_id = p_member_id
       AND NOT EXISTS (SELECT 1 FROM commitments WHERE roster.player_id = ANY(commitments.drop_player_ids))
       AND NOT EXISTS (
         SELECT 1
           FROM commitments
           JOIN trade_items item ON item.trade_id = commitments.id
          WHERE item.from_member_id = p_member_id
            AND item.player_id = roster.player_id)
  ), incoming AS (
    SELECT item.player_id, item.to_ir AS on_ir, item.to_taxi OR roster.is_on_taxi AS on_taxi
      FROM commitments
      JOIN trade_items item ON item.trade_id = commitments.id AND item.to_member_id = p_member_id
      JOIN roster_players roster ON roster.league_season_id = p_season_id AND roster.player_id = item.player_id
  ), extra_add AS (
    SELECT (p_extra->>'addPlayerId')::uuid AS player_id,
      COALESCE((p_extra->>'toIr')::boolean, false) AS on_ir,
      COALESCE((p_extra->>'toTaxi')::boolean, false) AS on_taxi
     WHERE p_extra IS NOT NULL
       AND NULLIF(p_extra->>'addPlayerId', '') IS NOT NULL
  )
  SELECT player_id, on_ir, on_taxi FROM retained
   WHERE NOT player_id IN (SELECT player_id FROM extra_drop)
  UNION ALL
  SELECT player_id, on_ir, on_taxi FROM incoming
   WHERE NOT player_id IN (SELECT player_id FROM extra_drop)
  UNION ALL
  SELECT player_id, on_ir, on_taxi FROM extra_add
$$;

CREATE OR REPLACE FUNCTION private.trade_hold_conflict(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_trade_id uuid,
  p_can_withdraw boolean,
  p_remedy text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_names text[];
  v_label text;
  v_message text;
BEGIN
  SELECT array_agg(member.team_name ORDER BY participant.sort_order, participant.member_id)
    INTO v_names
    FROM trade_participants participant
    JOIN league_members member ON member.id = participant.member_id
   WHERE participant.trade_id = p_trade_id
     AND participant.member_id <> p_member_id;

  IF v_names IS NULL OR cardinality(v_names) = 0 THEN
    v_label := 'Your accepted trade';
  ELSIF cardinality(v_names) = 1 THEN
    v_label := 'Your accepted trade with ' || v_names[1];
  ELSE
    v_label := 'Your accepted trade with '
      || array_to_string(v_names[1:cardinality(v_names) - 1], ', ')
      || ' and ' || v_names[cardinality(v_names)];
  END IF;

  v_message := v_label || ' needs this roster spot. '
    || CASE WHEN p_remedy = 'add' THEN 'Add a drop' ELSE 'Drop a player' END
    || CASE WHEN p_can_withdraw THEN ' or withdraw your acceptance.' ELSE '.' END;

  RETURN jsonb_build_object(
    'tradeId', p_trade_id,
    'partnerTeamNames', COALESCE(to_jsonb(v_names), '[]'::jsonb),
    'canWithdraw', p_can_withdraw,
    'message', v_message
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.trade_hold_conflicts(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_extra jsonb DEFAULT NULL,
  p_remedy text DEFAULT 'drop',
  p_include_trade_id uuid DEFAULT NULL,
  p_commit_trade boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_conflicts jsonb := '[]'::jsonb;
  v_trade_id uuid;
  v_counts record;
  v_base_ids uuid[];
BEGIN
  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(array_agg(trade.id), '{}'::uuid[])
    INTO v_base_ids
    FROM trades trade
    JOIN trade_participants participant
      ON participant.trade_id = trade.id
     AND participant.member_id = p_member_id
   WHERE trade.league_id = p_league_id
     AND trade.league_season_id = p_season_id
     AND trade.status = 'accepted';

  IF p_commit_trade AND p_include_trade_id IS NOT NULL AND NOT p_include_trade_id = ANY(v_base_ids) THEN
    v_base_ids := v_base_ids || p_include_trade_id;
  END IF;

  FOR v_trade_id IN
    SELECT trade.id
      FROM trades trade
      JOIN trade_participants participant
        ON participant.trade_id = trade.id
       AND participant.member_id = p_member_id
     WHERE trade.league_id = p_league_id
       AND trade.league_season_id = p_season_id
       AND trade.status = 'accepted'
     ORDER BY trade.id
  LOOP
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_counts
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_base_ids, p_extra);
    IF v_counts.active > v_league.roster_size
      OR v_counts.ir > v_league.ir_slots
      OR v_counts.taxi > v_league.taxi_slots THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, v_trade_id, false, p_remedy);
    END IF;
  END LOOP;

  IF p_include_trade_id IS NOT NULL AND NOT p_commit_trade THEN
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_counts
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_base_ids || p_include_trade_id, p_extra);
    IF v_counts.active > v_league.roster_size
      OR v_counts.ir > v_league.ir_slots
      OR v_counts.taxi > v_league.taxi_slots THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, p_include_trade_id, false, p_remedy);
    END IF;
  END IF;

  FOR v_trade_id IN
    SELECT trade.id
      FROM trades trade
      JOIN trade_participants participant
        ON participant.trade_id = trade.id
       AND participant.member_id = p_member_id
     WHERE trade.league_id = p_league_id
       AND trade.league_season_id = p_season_id
       AND trade.status = 'pending'
       AND participant.accepted_at IS NOT NULL
       AND (p_include_trade_id IS NULL OR trade.id <> p_include_trade_id)
     ORDER BY trade.id
  LOOP
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_counts
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_base_ids || v_trade_id, p_extra);
    IF v_counts.active > v_league.roster_size
      OR v_counts.ir > v_league.ir_slots
      OR v_counts.taxi > v_league.taxi_slots THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, v_trade_id, true, p_remedy);
    END IF;
  END LOOP;

  RETURN v_conflicts;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_roster_holds(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_extra jsonb DEFAULT NULL,
  p_remedy text DEFAULT 'drop',
  p_include_trade_id uuid DEFAULT NULL,
  p_commit_trade boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_conflicts jsonb;
BEGIN
  v_conflicts := private.trade_hold_conflicts(p_league_id, p_season_id, p_member_id, p_extra, p_remedy, p_include_trade_id, p_commit_trade);
  IF jsonb_array_length(v_conflicts) > 0 THEN
    RAISE EXCEPTION '%', v_conflicts->0->>'message'
      USING ERRCODE = 'PT409',
            DETAIL = jsonb_build_object('code', 'roster_hold', 'conflicts', v_conflicts)::text;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_accepted_trade_capacity(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_include_trade_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  PERFORM private.assert_trade_roster_holds(p_league_id,p_season_id,p_member_id,NULL,'drop',p_include_trade_id);
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_acceptance_holds(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_include_trade_id uuid DEFAULT NULL,p_commit_trade boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  PERFORM private.assert_trade_roster_holds(p_league_id,p_season_id,p_member_id,NULL,'add',p_include_trade_id,p_commit_trade);
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_only_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_faab record;
BEGIN
  FOR v_faab IN
    SELECT from_member_id,sum(faab_amount)::int amount FROM trade_items
      WHERE trade_id=p_trade_id AND faab_amount>0 GROUP BY from_member_id ORDER BY from_member_id
  LOOP
    IF private.available_faab_balance(p_league_id,p_league_season_id,v_faab.from_member_id,p_trade_id)<v_faab.amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.' USING ERRCODE='PA010';
    END IF;
  END LOOP;
  PERFORM private.validate_trade_rosters(p_trade_id, p_only_member_id);
  PERFORM private.assert_trade_acceptance_holds(p_league_id,p_league_season_id,participant.member_id,p_trade_id,p_only_member_id IS NULL)
    FROM trade_participants participant WHERE participant.trade_id=p_trade_id
      AND (p_only_member_id IS NULL OR participant.member_id=p_only_member_id);
  PERFORM 1
    FROM trade_items AS item
    JOIN roster_players AS roster
      ON roster.league_id = p_league_id
     AND roster.league_season_id = p_league_season_id
     AND roster.member_id = item.from_member_id
     AND roster.player_id = item.player_id
   WHERE item.trade_id = p_trade_id
     AND item.player_id IS NOT NULL
   ORDER BY roster.id
   FOR UPDATE OF roster;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM roster_players AS roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.member_id = item.from_member_id
            AND roster.player_id = item.player_id
            AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (roster.is_on_ir = false AND roster.is_on_taxi = false))
       )
  ) THEN
    RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, item.player_id, NULL, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.player_id IS NOT NULL;

  PERFORM 1
    FROM trade_items AS item
    JOIN draft_picks AS pick
      ON pick.id = item.pick_id
     AND pick.league_id = p_league_id
     AND pick.current_owner_id = item.from_member_id
     AND pick.is_used = false
   WHERE item.trade_id = p_trade_id
     AND item.pick_id IS NOT NULL
   ORDER BY pick.id
   FOR UPDATE OF pick;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.pick_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM draft_picks AS pick
          WHERE pick.id = item.pick_id
            AND pick.league_id = p_league_id
            AND pick.current_owner_id = item.from_member_id
            AND pick.is_used = false
       )
  ) THEN
    RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, NULL, item.pick_id, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.pick_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trade_roster_hold_check(
  p_member_id uuid,
  p_user_id uuid,
  p_add_player_id uuid DEFAULT NULL,
  p_drop_player_ids uuid[] DEFAULT '{}'::uuid[],
  p_to_ir boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member league_members%ROWTYPE;
  v_season_id uuid;
BEGIN
  SELECT * INTO v_member FROM league_members WHERE id = p_member_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_season_id FROM league_seasons WHERE league_id = v_member.league_id AND is_current = true LIMIT 1;
  IF v_season_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN private.trade_hold_conflicts(
    v_member.league_id,
    v_season_id,
    p_member_id,
    jsonb_build_object(
      'addPlayerId', p_add_player_id,
      'dropPlayerIds', to_jsonb(COALESCE(p_drop_player_ids, '{}'::uuid[])),
      'toIr', COALESCE(p_to_ir, false),
      'toTaxi', COALESCE(p_to_taxi, false)
    ),
    'add',
    NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.retract_trade_acceptance_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.retract_trade_acceptance_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_trade trades%ROWTYPE;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);

  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM league_members WHERE id = p_member_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM trade_participants WHERE trade_id = p_trade_id AND member_id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a trade participant can retract this trade.' USING ERRCODE = '42501';
  END IF;

  FOR v_member_lock IN
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
     ORDER BY participant.member_id ASC
  LOOP
    IF NOT pg_try_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_member_lock::text)
    ) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
    END IF;
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id FROM (
      SELECT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL
      UNION SELECT unnest(drop_player_ids) FROM trade_participants WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
  LOOP
    IF NOT pg_try_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    ) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
    END IF;
  END LOOP;

  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'Every team has accepted this trade, so acceptance can no longer be withdrawn.' USING ERRCODE = 'PT409';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trade_participants
     WHERE trade_id = p_trade_id AND member_id = p_member_id AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'You have not accepted this trade.' USING ERRCODE = 'PT409';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trade_participants
     WHERE trade_id = p_trade_id AND accepted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Every team has accepted this trade, so acceptance can no longer be withdrawn.' USING ERRCODE = 'PT409';
  END IF;

  UPDATE trade_participants
     SET accepted_at = NULL
   WHERE trade_id = p_trade_id
     AND member_id = p_member_id
     AND accepted_at IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'You have not accepted this trade.' USING ERRCODE = 'PT409';
  END IF;

  __request_result := jsonb_build_object('ok', true, 'tradeId', p_trade_id); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
END;
$$;

REVOKE ALL ON FUNCTION private.trade_hold_roster(uuid,uuid,uuid,uuid[],jsonb),private.trade_hold_conflict(uuid,uuid,uuid,uuid,boolean,text),private.trade_hold_conflicts(uuid,uuid,uuid,jsonb,text,uuid,boolean),private.assert_trade_roster_holds(uuid,uuid,uuid,jsonb,text,uuid,boolean),private.assert_trade_acceptance_holds(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trade_roster_hold_check(uuid,uuid,uuid,uuid[],boolean,boolean),public.retract_trade_acceptance_atomic(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trade_roster_hold_check(uuid,uuid,uuid,uuid[],boolean,boolean),public.retract_trade_acceptance_atomic(uuid,uuid,uuid) TO service_role;

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
  v_problem_kind text;
  v_problem_message text;
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

  SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
    INTO v_problem_kind,v_problem_message
    FROM private.roster_problems(p_league_id,v_season_id,p_member_id) problem
    LEFT JOIN roster_players chosen ON chosen.id=problem.roster_player_id AND chosen.player_id=p_drop_player_id
   WHERE chosen.id IS NULL
   GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
  IF v_problem_kind IS NOT NULL THEN
    RAISE EXCEPTION '%',v_problem_message USING ERRCODE=CASE v_problem_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
  END IF;

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

  PERFORM private.assert_trade_roster_holds(
    p_league_id,
    v_season_id,
    p_member_id,
    jsonb_build_object(
      'addPlayerId', p_player_id,
      'dropPlayerIds', CASE WHEN p_drop_player_id IS NULL THEN '[]'::jsonb ELSE to_jsonb(ARRAY[p_drop_player_id]) END,
      'toIr', COALESCE(p_to_ir, false),
      'toTaxi', COALESCE(p_to_taxi, false)
    ),
    'add',
    NULL
  );

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

  PERFORM private.assert_trade_roster_holds(
    v_claim.league_id,
    v_claim.league_season_id,
    p_member_id,
    jsonb_build_object(
      'addPlayerId', v_claim.player_id,
      'dropPlayerIds', CASE WHEN p_drop_player_id IS NULL THEN '[]'::jsonb ELSE to_jsonb(ARRAY[p_drop_player_id]) END,
      'toIr', COALESCE(p_to_ir, v_claim.to_ir),
      'toTaxi', COALESCE(p_to_taxi, v_claim.to_taxi)
    ),
    'add',
    NULL
  );

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
