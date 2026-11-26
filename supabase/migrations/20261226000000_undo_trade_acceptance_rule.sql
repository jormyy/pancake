BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION private.can_undo_trade_acceptance(
  p_trade_id uuid,
  p_member_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM trades trade
     WHERE trade.id = p_trade_id
       AND trade.status = 'pending'::trade_status
       AND (SELECT count(*) FROM trade_participants participant WHERE participant.trade_id = trade.id) >= 3
       AND EXISTS (
         SELECT 1 FROM trade_participants participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id = p_member_id
            AND participant.accepted_at IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM trade_participants participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id <> p_member_id
            AND participant.accepted_at IS NULL)
  );
$$;

DROP FUNCTION public.retract_trade_acceptance_atomic(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.retract_trade_acceptance_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
  v_trade trades%ROWTYPE;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'retract');
  __request_context := private.request_begin('public.retract_trade_acceptance_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id, p_expected_version), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_rows int;
BEGIN
  IF v_trade.status IN ('edited'::trade_status, 'countered'::trade_status)
    OR (p_expected_version IS NOT NULL AND v_trade.version <> p_expected_version) THEN
    RAISE EXCEPTION 'This offer changed. Reopen it to see the current version.' USING ERRCODE = 'PT409';
  END IF;

  IF v_trade.status IN ('accepted'::trade_status, 'completed'::trade_status) THEN
    RAISE EXCEPTION 'Every team has accepted this trade, so acceptance can no longer be undone.' USING ERRCODE = 'PT409';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.' USING ERRCODE = 'PT409';
  END IF;

  IF (SELECT count(*) FROM trade_participants WHERE trade_id = p_trade_id) < 3 THEN
    RAISE EXCEPTION 'Undo acceptance is only for trades with three or more teams.' USING ERRCODE = 'PT409';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trade_participants
     WHERE trade_id = p_trade_id AND member_id = p_member_id AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'You have not accepted this trade.' USING ERRCODE = 'PT409';
  END IF;

  IF NOT private.can_undo_trade_acceptance(p_trade_id, p_member_id) THEN
    RAISE EXCEPTION 'Every team has accepted this trade, so acceptance can no longer be undone.' USING ERRCODE = 'PT409';
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

REVOKE ALL ON FUNCTION public.retract_trade_acceptance_atomic(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retract_trade_acceptance_atomic(uuid, uuid, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION private.trade_hold_conflict(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_trade_id uuid,
  p_can_withdraw boolean,
  p_remedy text,
  p_actor_member_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_names text[];
  v_holder_name text;
  v_label text;
  v_message text;
  v_offer boolean := NOT p_can_withdraw AND EXISTS (
    SELECT 1 FROM trades trade
     WHERE trade.id = p_trade_id AND trade.status = 'pending'::trade_status AND trade.proposer_member_id = p_member_id);
BEGIN
  SELECT member.team_name INTO v_holder_name FROM league_members member WHERE member.id = p_member_id;

  SELECT array_agg(member.team_name ORDER BY participant.sort_order, participant.member_id)
    INTO v_names
    FROM trade_participants participant
    JOIN league_members member ON member.id = participant.member_id
   WHERE participant.trade_id = p_trade_id
     AND participant.member_id <> p_member_id;

  IF p_actor_member_id IS NULL OR p_actor_member_id = p_member_id THEN
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
      || CASE WHEN p_can_withdraw THEN ' or undo your acceptance.' WHEN v_offer THEN ' or withdraw your offer.' ELSE '.' END;
  ELSE
    IF v_names IS NULL OR cardinality(v_names) = 0 THEN
      v_label := v_holder_name || '''s accepted trade';
    ELSIF cardinality(v_names) = 1 THEN
      v_label := v_holder_name || '''s accepted trade with ' || v_names[1];
    ELSE
      v_label := v_holder_name || '''s accepted trade with '
        || array_to_string(v_names[1:cardinality(v_names) - 1], ', ')
        || ' and ' || v_names[cardinality(v_names)];
    END IF;
    v_message := v_label || ' needs the roster spot this trade would use. '
      || v_holder_name || ' has to make room'
      || CASE WHEN p_can_withdraw THEN ' or undo that acceptance first.' WHEN v_offer THEN ' or withdraw that offer first.' ELSE ' first.' END;
  END IF;

  RETURN jsonb_build_object(
    'tradeId', p_trade_id,
    'version', (SELECT trade.version FROM trades trade WHERE trade.id = p_trade_id),
    'holderTeamName', v_holder_name,
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
  p_commit_trade boolean DEFAULT false,
  p_actor_member_id uuid DEFAULT NULL,
  p_baseline jsonb DEFAULT NULL
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
  v_after record;
  v_before record;
  v_base_ids uuid[];
  v_after_ids uuid[];
  v_baseline_hold jsonb;
  v_conflict boolean;
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

  v_after_ids := v_base_ids;
  IF p_include_trade_id IS NOT NULL AND p_commit_trade AND NOT p_include_trade_id = ANY(v_after_ids) THEN
    v_after_ids := v_after_ids || p_include_trade_id;
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
      INTO v_after
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_after_ids, p_extra);
    v_baseline_hold := p_baseline->(v_trade_id::text);
    IF v_baseline_hold IS NOT NULL THEN
      SELECT (v_baseline_hold->>'active')::bigint AS active,
             (v_baseline_hold->>'ir')::bigint AS ir,
             (v_baseline_hold->>'taxi')::bigint AS taxi
        INTO v_before;
      v_conflict := GREATEST(0, v_after.active - v_league.roster_size) > GREATEST(0, v_before.active - v_league.roster_size)
        OR GREATEST(0, v_after.ir - v_league.ir_slots) > GREATEST(0, v_before.ir - v_league.ir_slots)
        OR GREATEST(0, v_after.taxi - v_league.taxi_slots) > GREATEST(0, v_before.taxi - v_league.taxi_slots);
    ELSE
      v_conflict := v_after.active > v_league.roster_size
        OR v_after.ir > v_league.ir_slots
        OR v_after.taxi > v_league.taxi_slots;
    END IF;
    IF v_conflict THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, v_trade_id, false, p_remedy, p_actor_member_id);
    END IF;
  END LOOP;

  IF p_include_trade_id IS NOT NULL AND NOT p_commit_trade THEN
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_after
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_after_ids || p_include_trade_id, p_extra);
    v_baseline_hold := p_baseline->(p_include_trade_id::text);
    IF v_baseline_hold IS NOT NULL THEN
      SELECT (v_baseline_hold->>'active')::bigint AS active,
             (v_baseline_hold->>'ir')::bigint AS ir,
             (v_baseline_hold->>'taxi')::bigint AS taxi
        INTO v_before;
      v_conflict := GREATEST(0, v_after.active - v_league.roster_size) > GREATEST(0, v_before.active - v_league.roster_size)
        OR GREATEST(0, v_after.ir - v_league.ir_slots) > GREATEST(0, v_before.ir - v_league.ir_slots)
        OR GREATEST(0, v_after.taxi - v_league.taxi_slots) > GREATEST(0, v_before.taxi - v_league.taxi_slots);
    ELSE
      v_conflict := v_after.active > v_league.roster_size
        OR v_after.ir > v_league.ir_slots
        OR v_after.taxi > v_league.taxi_slots;
    END IF;
    IF v_conflict THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, p_include_trade_id, false, p_remedy, p_actor_member_id);
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
       AND (NOT p_commit_trade OR p_include_trade_id IS NULL
         OR trade.id NOT IN (SELECT withdrawn.trade_id FROM private.pending_trades_withdrawn_by(p_include_trade_id) withdrawn))
     ORDER BY trade.id
  LOOP
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_after
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_after_ids || v_trade_id, p_extra);
    v_baseline_hold := p_baseline->(v_trade_id::text);
    IF v_baseline_hold IS NOT NULL THEN
      SELECT (v_baseline_hold->>'active')::bigint AS active,
             (v_baseline_hold->>'ir')::bigint AS ir,
             (v_baseline_hold->>'taxi')::bigint AS taxi
        INTO v_before;
      v_conflict := GREATEST(0, v_after.active - v_league.roster_size) > GREATEST(0, v_before.active - v_league.roster_size)
        OR GREATEST(0, v_after.ir - v_league.ir_slots) > GREATEST(0, v_before.ir - v_league.ir_slots)
        OR GREATEST(0, v_after.taxi - v_league.taxi_slots) > GREATEST(0, v_before.taxi - v_league.taxi_slots);
    ELSE
      v_conflict := v_after.active > v_league.roster_size
        OR v_after.ir > v_league.ir_slots
        OR v_after.taxi > v_league.taxi_slots;
    END IF;
    IF v_conflict THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, v_trade_id,
        private.can_undo_trade_acceptance(v_trade_id, p_member_id), p_remedy, p_actor_member_id);
    END IF;
  END LOOP;

  RETURN v_conflicts;
END;
$$;

COMMIT;
