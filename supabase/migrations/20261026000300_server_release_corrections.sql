DROP FUNCTION IF EXISTS private.validate_trade_rosters(uuid);

DROP FUNCTION IF EXISTS private.can_acquire_draft_taxi(uuid,uuid,uuid,uuid,uuid);

CREATE OR REPLACE FUNCTION private.validate_trade_rosters(p_trade_id uuid, p_only_member_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_league leagues%ROWTYPE; v_team record; v_count record;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  SELECT * INTO v_league FROM leagues WHERE id = v_trade.league_id FOR UPDATE;
  IF NOT v_league.allow_inactive_trades THEN RETURN; END IF;
  PERFORM 1 FROM players player
    WHERE player.id IN (SELECT player_id FROM trade_items WHERE trade_id=p_trade_id)
    ORDER BY player.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id
      AND member_id=item.from_member_id AND player_id=item.player_id)) THEN
    RAISE EXCEPTION 'A trade player is no longer owned by the expected team.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN players player ON player.id = item.player_id
    WHERE item.trade_id = p_trade_id AND item.to_ir AND
      (item.to_taxi OR NOT private.is_ir_designation(player.injury_status))) THEN
    RAISE EXCEPTION 'Incoming IR players must be Out or IR-designated and cannot also enter taxi.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
      ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
    WHERE item.trade_id = p_trade_id AND item.to_taxi
      AND NOT private.taxi_player_eligible(v_trade.league_id, item.player_id)) THEN
    RAISE EXCEPTION 'Incoming taxi players must be rookies or have fewer than 65 career regular-season games.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
    ON roster.league_season_id=v_trade.league_season_id AND roster.player_id=item.player_id
    JOIN league_seasons season ON season.id=roster.league_season_id
    WHERE item.trade_id=p_trade_id AND item.to_taxi AND v_league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(v_trade.league_id,roster.player_id,season.season_year)>=v_league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'Incoming taxi player has reached the taxi tenure limit.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN league_member_taxi_exits exit
    ON exit.league_id=v_trade.league_id AND exit.member_id=item.to_member_id AND exit.player_id=item.player_id
    WHERE item.trade_id=p_trade_id AND item.to_taxi) THEN
    RAISE EXCEPTION 'A promoted player cannot return to this team taxi squad.' USING ERRCODE='PT001';
  END IF;
  FOR v_team IN SELECT participant.*, member.team_name FROM trade_participants participant
    JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id
      AND (p_only_member_id IS NULL OR participant.member_id = p_only_member_id)
    ORDER BY participant.member_id LOOP
    IF EXISTS (SELECT 1 FROM unnest(v_team.drop_player_ids) drop_choice(player_id) WHERE
      NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id = v_trade.league_season_id
        AND roster.member_id = v_team.member_id AND roster.player_id = drop_choice.player_id)
      OR EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id AND item.player_id = drop_choice.player_id)
      OR private.is_reserved_trade_asset(v_trade.league_id, v_trade.league_season_id, v_team.member_id, drop_choice.player_id, NULL, p_trade_id)
      OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id AND status='pending' AND drop_player_id=drop_choice.player_id)) THEN
      RAISE EXCEPTION 'A selected trade drop is missing, reserved, or included in the offer.' USING ERRCODE = 'PT001';
    END IF;
    SELECT count(*) AS total, count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
      count(*) FILTER (WHERE on_ir) AS ir, count(*) FILTER (WHERE on_taxi) AS taxi INTO v_count
    FROM (
      SELECT roster.is_on_ir AS on_ir, roster.is_on_taxi AS on_taxi FROM roster_players roster
      WHERE roster.league_season_id = v_trade.league_season_id AND roster.member_id = v_team.member_id
        AND NOT roster.player_id = ANY(v_team.drop_player_ids)
        AND NOT EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id
          AND item.from_member_id = v_team.member_id AND item.player_id = roster.player_id)
      UNION ALL
      SELECT item.to_ir, item.to_taxi OR roster.is_on_taxi FROM trade_items item
      JOIN roster_players roster ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
      WHERE item.trade_id = p_trade_id AND item.to_member_id = v_team.member_id
    ) resulting;
    IF v_count.total > v_league.roster_size + v_league.ir_slots + v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the total roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.active > v_league.roster_size THEN
      RAISE EXCEPTION '% must change its trade plan to meet the active roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.ir > v_league.ir_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the IR limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.taxi > v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the taxi limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_trade_offer_atomic(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_action text, p_payload jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member_league uuid;
  v_multi boolean;
  v_league uuid;
  v_season uuid;
  v_recipient uuid;
  v_source uuid;
  v_notes text;
  v_expiration timestamptz;
  v_offer_players uuid[];
  v_request_players uuid[];
  v_offer_picks uuid[];
  v_request_picks uuid[];
  v_offer_faab int;
  v_request_faab int;
  v_participants uuid[];
  v_items jsonb;
  v_envelope jsonb;
  v_receipt private.trade_offer_requests%ROWTYPE;
  v_inserted int;
  v_result uuid;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('propose','propose-multi','edit','edit-multi','counter','counter-multi')
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A request key, supported offer action, and offer payload are required.' USING ERRCODE='22023';
  END IF;
  SELECT league_id INTO v_member_league FROM league_members
    WHERE id=p_member_id AND user_id=p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE='42501';
  END IF;

  v_multi := p_action LIKE '%-multi';
  v_notes := NULLIF(btrim(p_payload->>'notes'),'');
  v_expiration := (p_payload->>'expiresAt')::timestamptz;
  v_envelope := jsonb_build_object('version',1,'action',p_action,'memberId',p_member_id,
    'notes',v_notes,'expiresAt',v_expiration);
  IF p_payload ? 'rosterPlan' THEN v_envelope := v_envelope||jsonb_build_object('rosterPlan',p_payload->'rosterPlan'); END IF;
  IF p_action IN ('propose','propose-multi') THEN
    v_league := (p_payload->>'leagueId')::uuid;
    v_season := (p_payload->>'leagueSeasonId')::uuid;
    IF v_league IS DISTINCT FROM v_member_league OR v_season IS NULL THEN
      RAISE EXCEPTION 'The offer must use this member''s league and a season.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season);
    IF NOT v_multi THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  ELSE
    v_source := (p_payload->>'tradeId')::uuid;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'The source trade is required.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('tradeId',v_source);
    IF NOT v_multi AND p_payload ? 'recipientMemberId' THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  END IF;
  IF v_multi THEN
    v_participants := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[];
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
      'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
      'faabAmount',COALESCE((item->>'faabAmount')::int,0)) ORDER BY ordinal),'[]'::jsonb)
      INTO v_items FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) WITH ORDINALITY AS items(item,ordinal);
    v_envelope := v_envelope||jsonb_build_object('participantMemberIds',v_participants,'items',v_items);
  ELSE
    v_offer_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[];
    v_request_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[];
    v_offer_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPickIds','[]'::jsonb)))::uuid[];
    v_request_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPickIds','[]'::jsonb)))::uuid[];
    v_offer_faab := COALESCE((p_payload->>'offerFaabAmount')::int,0);
    v_request_faab := COALESCE((p_payload->>'requestFaabAmount')::int,0);
    v_envelope := v_envelope||jsonb_build_object('offerPlayerIds',v_offer_players,'requestPlayerIds',v_request_players,
      'offerPickIds',v_offer_picks,'requestPickIds',v_request_picks,
      'offerFaabAmount',v_offer_faab,'requestFaabAmount',v_request_faab);
  END IF;

  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload)
    VALUES(p_user_id,p_request_id,p_member_id,v_envelope) ON CONFLICT(user_id,request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  -- The separate statement sees a concurrent claim after its transaction commits.
  SELECT * INTO STRICT v_receipt FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id FOR UPDATE;
  IF v_receipt.member_id IS DISTINCT FROM p_member_id OR v_receipt.request_payload IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'This request key already belongs to different trade terms.' USING ERRCODE='22023';
  END IF;
  IF v_receipt.completed THEN RETURN v_receipt.result_trade_id; END IF;
  IF v_inserted=0 THEN
    RAISE EXCEPTION 'This trade request has no completed receipt.' USING ERRCODE='55000';
  END IF;

  IF p_action='propose' THEN
    v_result := public.propose_trade_atomic(v_league,v_season,p_member_id,v_recipient,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  ELSIF p_action='propose-multi' THEN
    v_result := public.propose_multi_team_trade_atomic(v_league,v_season,p_member_id,v_participants,v_items,v_notes,v_expiration);
  ELSIF v_multi THEN
    v_result := private.replace_multi_team_trade_offer(v_source,p_member_id,p_user_id,split_part(p_action,'-',1),
      v_participants,v_items,v_notes,v_expiration);
  ELSE
    IF p_payload ? 'recipientMemberId' AND v_recipient IS DISTINCT FROM (
      SELECT CASE WHEN p_action='counter' THEN proposer_member_id ELSE recipient_member_id END
        FROM public.trades WHERE id=v_source AND league_id=v_member_league
    ) THEN
      RAISE EXCEPTION 'The replacement must keep the original counterparty.' USING ERRCODE='22023';
    END IF;
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' AND v_result IS NOT NULL THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[]);
  END IF;
  IF v_result IS NOT NULL THEN
    PERFORM private.validate_trade_rosters(v_result, p_member_id);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM private.validate_trade_rosters(p_trade_id);
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

CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_balance int;
  v_item_faab_amount int;
  v_previous_flag text;
  v_drop record;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
        UNION
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_lock::text));
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id FROM (
      SELECT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL
      UNION SELECT unnest(drop_player_ids) FROM trade_participants WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_trade.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.validate_trade_rosters(p_trade_id);

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false))
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSIF v_item.pick_id IS NOT NULL THEN
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

    END IF;
  END LOOP;

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    UPDATE faab_balances
       SET balance = balance - v_item_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_from_member
       AND balance >= v_item_faab_amount;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  -- A reserved pick may only change hands through this completion; the
  -- draft_picks guard and the trade status guard honour this mark.
  v_previous_flag := private.begin_trade_lifecycle_write();
  IF v_league.allow_inactive_trades THEN
    FOR v_drop IN SELECT roster.* FROM trade_participants participant JOIN roster_players roster
      ON roster.member_id=participant.member_id AND roster.league_season_id=v_trade.league_season_id
        AND roster.player_id=ANY(participant.drop_player_ids)
      WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
    LOOP
      PERFORM private.release_roster_player_to_waivers(v_drop.id,v_trade.league_id,v_trade.league_season_id,
        v_drop.member_id,v_drop.player_id,'drop',NULL,p_trade_id);
    END LOOP;
  END IF;

  WITH changed_claims AS (
    UPDATE waiver_claims AS claim
       SET status = 'cancelled',
           failure_reason = 'The selected drop player left this roster in another transaction.',
           processed_at = now(),
           drop_player_id = NULL
     WHERE claim.status = 'pending'
       AND claim.league_id = v_trade.league_id
       AND claim.league_season_id = v_trade.league_season_id
       AND EXISTS (
         SELECT 1 FROM trade_items AS item
          WHERE item.trade_id = p_trade_id
            AND item.from_member_id = claim.member_id
            AND item.player_id = claim.drop_player_id
            AND (v_league.allow_inactive_trades OR item.to_taxi OR item.to_ir)
       )
     RETURNING claim.id, claim.member_id, claim.failure_reason
  )
  INSERT INTO notification_outbox(dedupe_key, member_id, event_type, title, body, data, category)
  SELECT 'trade_claim_cancelled:' || id, member_id, 'trade_claim_cancelled', 'Waiver claim cancelled',
    failure_reason, jsonb_build_object('claimId', id), 'trade'
  FROM changed_claims
  ON CONFLICT (dedupe_key) DO NOTHING;

  UPDATE waiver_claims AS claim
     SET drop_player_id = NULL
   WHERE claim.status = 'pending'
     AND claim.league_id = v_trade.league_id
     AND claim.league_season_id = v_trade.league_season_id
     AND EXISTS (
       SELECT 1 FROM trade_items AS item
        WHERE item.trade_id = p_trade_id
          AND item.from_member_id = claim.member_id
          AND item.player_id = claim.drop_player_id
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;
    v_to_member := v_item.to_member_id;

    IF v_item.player_id IS NOT NULL THEN
      IF v_item.to_taxi OR v_league.allow_inactive_trades THEN
        PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
      END IF;
      BEGIN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade',
             is_on_taxi = v_item.to_taxi OR (v_league.allow_inactive_trades AND is_on_taxi),
             is_on_ir = CASE WHEN v_league.allow_inactive_trades THEN v_item.to_ir ELSE is_on_ir END
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false));

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        -- A game in progress only delays a taxi destination: keep the accepted trade for a later run.
        IF v_item.to_taxi AND SQLERRM LIKE 'This player''s game has already started%' THEN
          RAISE EXCEPTION 'A taxi destination waits for the player''s game slate to end.' USING ERRCODE='PT002';
        END IF;
        -- A changed destination precondition expires this trade, not the whole queue.
        RAISE EXCEPTION '% acquisition failed: %',
          CASE WHEN v_item.to_taxi THEN 'Taxi' WHEN v_item.to_ir THEN 'IR' ELSE 'Player' END,
          SQLERRM USING ERRCODE='PT001';
      END;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        acquired_to_taxi,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', false, p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', v_item.to_taxi, p_trade_id);
    ELSIF v_item.pick_id IS NOT NULL THEN
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO faab_balances (
        league_id,
        league_season_id,
        member_id,
        balance
      )
      VALUES (
        v_trade.league_id,
        v_trade.league_season_id,
        v_to_member,
        v_item_faab_amount
      )
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
         SET balance = faab_balances.balance + EXCLUDED.balance,
             updated_at = now();
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         completed_at = now(),
         completion_failure_reason = NULL
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    'trade_completed',
    'Trade completed',
    NULL,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    NULL,
    p_trade_id,
    NULL,
    jsonb_build_object(
      'proposer_faab_amount', v_trade.proposer_faab_amount,
      'recipient_faab_amount', v_trade.recipient_faab_amount,
      'is_multi_team', COALESCE(v_trade.is_multi_team, false)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_member_transaction_state(
  p_member_id uuid,
  p_league_id uuid
)
RETURNS TABLE (
  league_season_id uuid,
  week_number int,
  weekly_add_limit int,
  weekly_add_count int,
  waiver_mode text,
  faab_starting_budget int,
  faab_balance int,
  add_limit_resets_at timestamptz,
  add_limit_message text,
  add_limit_resets_label text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_resets_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RETURN;
  END IF;

  SELECT week.week_number, week.resets_at
    INTO v_week, v_resets_at
    FROM private.current_add_week(p_league_id, v_season_id) AS week;
  RETURN QUERY
  SELECT
    v_season_id,
    v_week,
    league.weekly_add_limit,
    COALESCE(count_row.add_count, 0),
    league.waiver_mode,
    league.faab_starting_budget,
    COALESCE(balance_row.balance, league.faab_starting_budget, 100) - (
      SELECT COALESCE(sum(item.faab_amount), 0)::int
      FROM trade_items AS item
      JOIN trades AS trade ON trade.id = item.trade_id
      WHERE trade.league_id = p_league_id
        AND trade.league_season_id = v_season_id
        AND trade.status = 'accepted'
        AND item.from_member_id = p_member_id
    ),
    v_resets_at,
    private.weekly_add_limit_message(COALESCE(count_row.add_count, 0), league.weekly_add_limit, v_resets_at),
    private.weekly_add_limit_reset_label(v_resets_at)
  FROM leagues AS league
  LEFT JOIN weekly_add_counts AS count_row
    ON count_row.league_id = league.id
   AND count_row.league_season_id = v_season_id
   AND count_row.member_id = p_member_id
   AND count_row.week_number = v_week
  LEFT JOIN faab_balances AS balance_row
    ON balance_row.league_id = league.id
   AND balance_row.league_season_id = v_season_id
   AND balance_row.member_id = p_member_id
  WHERE league.id = p_league_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_rookie_draft_id uuid;
  v_injury text;
  v_roster_size int;
  v_ir_slots int;
  v_other_ir_count int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status = 'completed'
   ORDER BY draft.created_at DESC LIMIT 1;
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
     AND NOT (v_league.status = 'offseason'::league_status AND p_to_ir = false) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF private.roster_status_game_started(v_rp.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_rp.is_on_ir = p_to_ir THEN RETURN; END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  IF p_to_ir THEN
    SELECT p.injury_status
      INTO v_injury
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_ir_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = true
       AND id <> p_roster_player_id;

    IF v_other_ir_count >= v_ir_slots THEN
      RAISE EXCEPTION 'You only have % IR slot%.', v_ir_slots, CASE WHEN v_ir_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_ir = p_to_ir,
         is_on_taxi = CASE WHEN p_to_ir THEN false ELSE is_on_taxi END
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle IR status'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_ir THEN 'ir_designate' ELSE 'ir_return' END
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid, p_expected_league_season_id uuid, p_rookie_draft_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_rows int;
  v_rookie_draft_id uuid;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status = 'completed'
   ORDER BY draft.created_at DESC LIMIT 1;
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_league_season_id IS NOT NULL
     AND v_rp.league_season_id <> p_expected_league_season_id THEN
    RAISE EXCEPTION 'The roster season has changed. Refresh before dropping a player.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_rookie_draft_id IS NOT NULL THEN
    IF p_expected_league_season_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM drafts
       WHERE id = p_rookie_draft_id
         AND league_id = v_rp.league_id
         AND league_season_id = v_rp.league_season_id
         AND draft_type = 'snake' AND NOT is_mock
         AND status IN ('in_progress', 'paused', 'completed')
    ) THEN
      RAISE EXCEPTION 'The draft has changed. Refresh before trimming the roster.' USING ERRCODE = 'P0001';
    END IF;
    IF v_rp.is_on_ir OR v_rp.is_on_taxi OR (
      SELECT count(*) FROM roster_players
       WHERE league_id = v_rp.league_id AND league_season_id = v_rp.league_season_id
         AND member_id = v_rp.member_id AND NOT is_on_ir AND NOT is_on_taxi
    ) <= v_league.roster_size THEN
      RAISE EXCEPTION 'The active roster no longer needs this drop. Refresh the roster.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    'fa_drop'
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION private.release_roster_player_to_waivers(
  p_roster_player_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_transaction_type text,
  p_related_claim_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_missing_message text DEFAULT 'Roster player is no longer on the expected roster.'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  DELETE FROM roster_players AS rp
   WHERE rp.id = p_roster_player_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.player_id = p_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '%', p_missing_message
      USING ERRCODE = 'PT001';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_player_id,
    p_member_id
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id,
    related_trade_id
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    p_player_id,
    p_transaction_type,
    p_related_claim_id,
    p_related_trade_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_season_boundary_after_grace(
  p_league_id uuid,
  p_league_season_id uuid,
  p_action text,
  p_reference_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start int;
  v_year int;
  v_type matchup_type;
  v_count int;
  v_ready boolean;
  v_latest timestamptz;
  v_result jsonb;
  v_next record;
  v_week int;
  v_input_token jsonb;
  v_round int;
  v_last_game_date date;
  v_end_week int;
  v_start_week int;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('generate', 'advance', 'rollover') OR p_reference_at IS NULL THEN
    RAISE EXCEPTION 'Invalid automatic season boundary request.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT COALESCE(season.playoff_start_week, league.playoff_start_week, 20), season.season_year INTO v_start, v_year
    FROM public.league_seasons season JOIN public.leagues league ON league.id = season.league_id
    WHERE season.id = p_league_season_id AND season.league_id = p_league_id AND season.is_current
    FOR UPDATE OF season;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied', false); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));
  PERFORM 1 FROM public.matchups WHERE league_season_id = p_league_season_id ORDER BY id FOR UPDATE;

  IF p_action = 'generate' THEN
    IF EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type <> 'regular_season') THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
    v_type := 'regular_season';
  ELSIF p_action = 'advance' THEN
    IF EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = 'playoff_final') THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
    SELECT max(playoff_round) INTO v_round FROM public.matchups WHERE league_season_id=p_league_season_id;
    v_type := CASE WHEN EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = 'playoff_semifinal')
      THEN 'playoff_semifinal'::matchup_type ELSE 'playoff_quarterfinal'::matchup_type END;
  ELSE
    v_type := 'playoff_final';
  END IF;

  SELECT count(*), bool_and(is_finalized IS TRUE AND (v_type = 'regular_season' OR winner_member_id IS NOT NULL)), max(finalized_at)
    INTO v_count, v_ready, v_latest
    FROM public.matchups WHERE league_season_id = p_league_season_id AND NOT is_voided AND (CASE WHEN v_round IS NOT NULL THEN playoff_round=v_round ELSE matchup_type=v_type END)
      AND (v_type <> 'regular_season' OR week_number < v_start);
  IF NOT (p_action = 'generate' AND v_start = 1) AND
      (v_count = 0 OR v_ready IS DISTINCT FROM true
        OR (p_action = 'rollover' AND v_latest > p_reference_at - interval '48 hours')) THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  IF (p_action = 'generate' AND v_start > 1) OR p_action = 'advance' THEN
    IF p_action = 'generate' THEN
      v_end_week := v_start - 1;
      v_start_week := v_end_week;
    ELSE
      SELECT min(week_number), max(COALESCE(end_week_number, week_number)) INTO v_start_week, v_end_week
        FROM public.matchups WHERE league_season_id = p_league_season_id AND NOT is_voided
          AND (CASE WHEN v_round IS NOT NULL THEN playoff_round = v_round ELSE matchup_type = v_type END);
    END IF;
    SELECT COALESCE(max(game.game_date), max(week.week_end)) INTO v_last_game_date
      FROM public.season_weeks AS week
      LEFT JOIN public.nba_games AS game
        ON game.season_year = week.season_year
       AND game.game_date BETWEEN week.week_start AND week.week_end
       AND public.is_regular_season_game_id(game.nba_game_id)
       AND private.lineup_game_available(game.status, game.game_status_text)
     WHERE week.season_year = v_year AND week.week_number BETWEEN v_start_week AND v_end_week;
    IF v_last_game_date IS NULL OR (p_reference_at AT TIME ZONE 'America/New_York')::date
        <= v_last_game_date + 1 THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
  END IF;

  -- Keep input revisions locked through the transition. Missing legacy
  -- certificates require an actual replay, never a timestamp backfill.
  FOR v_week IN SELECT DISTINCT week_number FROM public.matchups
      WHERE league_season_id = p_league_season_id AND NOT is_voided
        AND ((CASE WHEN v_round IS NOT NULL THEN playoff_round=v_round ELSE matchup_type=v_type END) OR (p_action = 'rollover' AND matchup_type = 'regular_season'))
        AND (matchup_type <> 'regular_season' OR week_number < v_start) ORDER BY week_number LOOP
    SELECT input_token INTO v_input_token FROM private.score_week_certificates
      WHERE league_season_id = p_league_season_id AND week_number = v_week;
    IF NOT private.lock_current_score_inputs(p_league_season_id, v_week, v_input_token) THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'stale_score_inputs', 'retryable', true);
    END IF;
  END LOOP;

  IF p_action = 'generate' THEN
    v_result := public.generate_playoff_bracket_atomic(p_league_id);
    UPDATE public.leagues SET status = 'playoffs' WHERE id = p_league_id AND status = 'active';
  ELSIF p_action = 'advance' THEN
    v_result := public.advance_playoff_bracket_atomic(p_league_id);
  ELSE
    SELECT * INTO v_next FROM public.advance_season_atomic(p_league_id);
    RETURN jsonb_build_object('applied', true, 'new_season_id', v_next.new_season_id, 'new_year', v_next.new_year);
  END IF;
  RETURN jsonb_build_object('applied', COALESCE((v_result->>'inserted')::int, 0) > 0);
END;
$$;

CREATE OR REPLACE FUNCTION private.can_acquire_draft_taxi(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_player_id uuid DEFAULT NULL,p_draft_id uuid DEFAULT NULL,p_roster_player_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT EXISTS(SELECT 1 FROM leagues l WHERE l.id=p_league_id AND l.taxi_slots >
    (SELECT count(*) FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.member_id=p_member_id AND r.is_on_taxi))
  AND EXISTS(SELECT 1 FROM players p WHERE (p_player_id IS NULL OR p.id=p_player_id)
    AND (p_draft_id IS NULL OR NOT EXISTS(SELECT 1 FROM nominations n WHERE n.draft_id=p_draft_id AND n.player_id=p.id))
    AND private.taxi_player_eligible(p_league_id,p.id)
    AND NOT EXISTS (SELECT 1 FROM leagues league JOIN league_seasons season ON season.id=p_season_id
      WHERE league.id=p_league_id AND league.taxi_max_seasons IS NOT NULL
        AND season.season_year-private.taxi_start_year(p_league_id,p.id,season.season_year)>=league.taxi_max_seasons)
    AND NOT private.roster_status_game_started(p.id)
    AND NOT EXISTS(SELECT 1 FROM league_member_taxi_exits x WHERE x.league_id=p_league_id AND x.member_id=p_member_id AND x.player_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.player_id=p.id
      AND (r.id IS DISTINCT FROM p_roster_player_id OR r.member_id<>p_member_id OR r.acquired_via<>'draft'
        OR NOT EXISTS(SELECT 1 FROM snake_draft_picks pick WHERE pick.draft_id=p_draft_id
          AND pick.member_id=p_member_id AND pick.player_id=p.id))));
$$;

CREATE OR REPLACE FUNCTION private.prevent_active_over_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'active'::league_status
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'drafting' AND EXISTS (
      SELECT 1 FROM league_seasons AS season
      JOIN drafts AS draft ON draft.league_season_id = season.id AND draft.league_id = NEW.id
      WHERE season.league_id = NEW.id AND season.is_current
        AND draft.draft_type = 'snake' AND draft.status = 'completed' AND NOT draft.is_mock
        AND private.draft_timer_opening_night_cutoff(season.season_year) <= now()
        AND NOT EXISTS (SELECT 1 FROM snake_draft_picks AS pick WHERE pick.draft_id = draft.id
          AND pick.player_id IS NULL AND pick.skipped_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM drafts AS unfinished WHERE unfinished.league_season_id = season.id
          AND unfinished.draft_type = 'snake' AND NOT unfinished.is_mock
          AND unfinished.status IN ('pending', 'in_progress', 'paused'))
    ) THEN
      RETURN NEW;
    END IF;
    PERFORM 1
      FROM league_seasons AS season
      JOIN league_members AS member
        ON member.league_id = NEW.id
      LEFT JOIN roster_players AS roster
        ON roster.league_id = NEW.id
       AND roster.league_season_id = season.id
       AND roster.member_id = member.id
       AND roster.is_on_ir = false
       AND roster.is_on_taxi = false
     WHERE season.league_id = NEW.id
       AND season.is_current = true
     GROUP BY member.id
    HAVING count(roster.id) > NEW.roster_size
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'League cannot become active while a roster exceeds the active roster cap.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.activate_rookie_draft_league_if_ready(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_rows int;
  v_unfilled_picks int;
  v_deadline boolean;
  v_member record;
  v_roster record;
  v_active int;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
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

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status <> 'completed'::draft_status THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = v_draft.league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND OR v_draft.league_season_id <> v_current_season.id THEN
    RETURN false;
  END IF;

  SELECT count(*)
    INTO v_unfilled_picks
    FROM snake_draft_picks
   WHERE draft_id = v_draft.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_unfilled_picks > 0 THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
     AND current_draft.is_mock = false
     AND current_draft.status IN (
       'pending'::draft_status,
       'in_progress'::draft_status,
       'paused'::draft_status
     )
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN false;
  END IF;

  v_deadline := COALESCE(private.draft_timer_opening_night_cutoff(v_current_season.season_year) <= now(), false);
  IF v_league.status = 'drafting' AND v_deadline THEN
    FOR v_member IN SELECT id FROM league_members WHERE league_id = v_draft.league_id ORDER BY id LOOP
      IF NOT pg_try_advisory_xact_lock(hashtext(v_draft.league_id::text), hashtext(v_member.id::text)) THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_active FROM roster_players
        WHERE league_season_id = v_current_season.id AND member_id = v_member.id
          AND NOT is_on_ir AND NOT is_on_taxi;
      FOR v_roster IN
        SELECT roster.id, roster.player_id FROM roster_players AS roster
          JOIN snake_draft_picks AS pick ON pick.draft_id = v_draft.id
            AND pick.member_id = roster.member_id AND pick.player_id = roster.player_id
          JOIN players AS player ON player.id = roster.player_id AND player.years_exp = 0
        WHERE roster.league_season_id = v_current_season.id AND roster.member_id = v_member.id
          AND roster.acquired_via = 'draft' AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
        ORDER BY pick.overall_pick DESC, roster.id FOR UPDATE OF roster SKIP LOCKED
      LOOP
        EXIT WHEN v_active <= v_league.roster_size;
        IF private.can_acquire_draft_taxi(v_draft.league_id, v_current_season.id, v_member.id,
          v_roster.player_id, v_draft.id, v_roster.id) THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id, v_current_season.id,
            v_member.id, v_roster.player_id, 'draft', v_draft.id);
          UPDATE roster_players SET is_on_taxi = true WHERE id = v_roster.id;
          INSERT INTO roster_transactions(league_id, league_season_id, member_id, player_id, transaction_type)
          VALUES(v_draft.league_id, v_current_season.id, v_member.id, v_roster.player_id, 'taxi_designate');
          v_active := v_active - 1;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  PERFORM 1
    FROM league_seasons AS season
    JOIN league_members AS member
      ON member.league_id = v_draft.league_id
    LEFT JOIN roster_players AS roster
      ON roster.league_id = v_draft.league_id
     AND roster.league_season_id = season.id
     AND roster.member_id = member.id
     AND roster.is_on_ir = false
     AND roster.is_on_taxi = false
   WHERE season.id = v_current_season.id
   GROUP BY member.id
  HAVING count(roster.id) > v_league.roster_size
   LIMIT 1;

  IF FOUND AND NOT v_deadline THEN
    RETURN false;
  END IF;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id
     AND status = 'drafting';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
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
    EXCEPTION WHEN SQLSTATE 'PA008' THEN
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

REVOKE ALL ON FUNCTION private.validate_trade_rosters(uuid,uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION private.can_acquire_draft_taxi(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
