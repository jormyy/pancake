CREATE OR REPLACE FUNCTION private.check_trade_legality(
  p_league_id uuid,p_season_id uuid,p_member_ids uuid[],p_items jsonb,p_plans jsonb,p_trade_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_league leagues%ROWTYPE; v_team record; v_row record; v_item record; v_move jsonb;
  v_plan jsonb; v_roster jsonb; v_drops jsonb; v_reasons jsonb; v_suggestions jsonb; v_teams jsonb:='[]';
  v_unavailable jsonb; v_destinations jsonb; v_ir_error text; v_taxi_error text; v_error text;
  v_active int; v_ir int; v_taxi int; v_total int; v_limit int; v_count int; v_excess int;
  v_year int; v_available int; v_cost int; v_location text; v_rule text; v_name text; v_ir_out text; v_fix text;
BEGIN
  SELECT * INTO STRICT v_league FROM leagues WHERE id=p_league_id;
  SELECT season_year INTO STRICT v_year FROM league_seasons WHERE id=p_season_id AND league_id=p_league_id;
  FOR v_team IN SELECT id,team_name FROM league_members WHERE league_id=p_league_id AND id=ANY(p_member_ids) ORDER BY array_position(p_member_ids,id)
  LOOP
    v_plan:=COALESCE(p_plans->v_team.id::text,'{}'); v_reasons:='[]'; v_unavailable:='{}'; v_destinations:='{}';
    WITH items AS (SELECT * FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)),
    retained AS (
      SELECT r.player_id,COALESCE(m.value->>'destination',CASE WHEN r.is_on_taxi THEN 'taxi' WHEN r.is_on_ir THEN 'ir' ELSE 'active' END) location,false incoming
      FROM roster_players r LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(COALESCE(v_plan->'rosterMoves','[]')) WHERE value->>'playerId'=r.player_id::text) m ON true
      WHERE r.league_season_id=p_season_id AND r.member_id=v_team.id
        AND NOT COALESCE(v_plan->'dropPlayerIds','[]') ? r.player_id::text
        AND NOT EXISTS(SELECT 1 FROM items WHERE "fromMemberId"=v_team.id AND "playerId"=r.player_id)
      UNION ALL
      SELECT i."playerId",CASE WHEN r.is_on_taxi OR COALESCE(i."toTaxi",false) OR COALESCE(v_plan->'taxiPlayerIds','[]') ? i."playerId"::text THEN 'taxi'
        WHEN COALESCE(i."toIR",false) OR COALESCE(v_plan->'irPlayerIds','[]') ? i."playerId"::text THEN 'ir' ELSE 'active' END,true
      FROM items i JOIN roster_players r ON r.league_season_id=p_season_id AND r.member_id=i."fromMemberId" AND r.player_id=i."playerId"
      WHERE i."toMemberId"=v_team.id
    ) SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',p.id,'name',p.display_name,'location',r.location,'incoming',r.incoming) ORDER BY p.display_name),'[]') INTO v_roster
      FROM retained r JOIN players p ON p.id=r.player_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',p.id,'name',p.display_name)),'[]') INTO v_drops
      FROM players p WHERE COALESCE(v_plan->'dropPlayerIds','[]') ? p.id::text;
    FOR v_row IN
      SELECT DISTINCT p.id,p.display_name,p.injury_status FROM players p WHERE p.id IN
        (SELECT (value->>'playerId')::uuid FROM jsonb_array_elements(v_roster)
         UNION SELECT player_id FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id) ORDER BY p.id
    LOOP
      v_error:=NULL;
      IF private.is_reserved_trade_asset(p_league_id,p_season_id,v_team.id,v_row.id,NULL,p_trade_id) THEN v_error:='Reserved by another trade.';
      ELSIF EXISTS(SELECT 1 FROM waiver_claims WHERE league_season_id=p_season_id AND member_id=v_team.id AND status='pending' AND drop_player_id=v_row.id) THEN v_error:='Reserved as a pending waiver drop.'; END IF;
      IF v_error IS NOT NULL THEN v_unavailable:=v_unavailable||jsonb_build_object(v_row.id,v_error); END IF;
      v_ir_error:=CASE WHEN v_league.ir_slots=0 THEN 'This league has no IR slots.' WHEN NOT private.is_ir_designation(v_row.injury_status) THEN 'IR requires an Out or IR designation.' END;
      v_taxi_error:=CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"toMemberId" uuid)
          WHERE i."playerId"=v_row.id AND i."toMemberId"=v_team.id)
          AND NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id AND player_id=v_row.id AND is_on_taxi)
          THEN 'Only incoming players can be placed on Taxi.'
        WHEN v_league.taxi_slots=0 THEN 'This league has no taxi slots.'
        WHEN EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=v_team.id AND player_id=v_row.id) THEN 'This player cannot return to this team taxi squad.'
        WHEN NOT private.taxi_player_eligible(p_league_id,v_row.id) THEN 'Taxi requires a rookie or fewer than 65 known career games.'
        WHEN v_league.taxi_max_seasons IS NOT NULL AND v_year-private.taxi_start_year(p_league_id,v_row.id,v_year)>=v_league.taxi_max_seasons THEN 'This player has reached the taxi tenure limit.' END;
      v_destinations:=v_destinations||jsonb_build_object(v_row.id,jsonb_strip_nulls(jsonb_build_object('ir',v_ir_error,'taxi',v_taxi_error)));
      SELECT value->>'location' INTO v_location FROM jsonb_array_elements(v_roster) WHERE value->>'playerId'=v_row.id::text;
      v_rule:=CASE WHEN v_location='ir' AND v_ir_error IS NOT NULL THEN 'ir_eligibility' WHEN v_location='taxi' AND v_taxi_error IS NOT NULL THEN 'taxi_eligibility' END;
      IF v_rule IS NOT NULL THEN
        v_error:=format('%s: %s cannot use %s. %s Move %s to Regular or choose a drop.',v_team.team_name,v_row.display_name,upper(v_location),CASE WHEN v_location='ir' THEN v_ir_error ELSE v_taxi_error END,v_row.display_name);
        v_suggestions:=jsonb_build_array(jsonb_build_object('action','move','playerId',v_row.id,'playerName',v_row.display_name,'destination','active','message',format('Move %s to Regular.',v_row.display_name)));
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_roster) WHERE value->>'playerId'=v_row.id::text AND (value->>'incoming')::boolean) THEN
          v_suggestions:=v_suggestions||jsonb_build_array(jsonb_build_object('action','drop','playerId',v_row.id,'playerName',v_row.display_name,'message',format('Drop %s.',v_row.display_name)));
        END IF;
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'playerId',v_row.id,'message',v_error,'suggestedMoves',v_suggestions));
      END IF;
    END LOOP;
    FOR v_item IN SELECT i.*,p.display_name,r.is_on_ir,r.is_on_taxi FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)
      JOIN players p ON p.id=i."playerId" LEFT JOIN roster_players r ON r.league_season_id=p_season_id AND r.member_id=i."fromMemberId" AND r.player_id=i."playerId"
      WHERE i."fromMemberId"=v_team.id ORDER BY i."playerId"
    LOOP
      v_rule:=NULL; v_error:=NULL;
      IF v_item.is_on_ir IS NULL THEN v_rule:='ownership'; v_error:=format('%s no longer owns %s. Remove this player from the trade.',v_team.team_name,v_item.display_name);
      ELSIF NOT v_league.allow_inactive_trades AND (v_item.is_on_ir OR v_item.is_on_taxi) THEN
        v_rule:=CASE WHEN v_item.is_on_ir THEN 'ir_trade_eligibility' ELSE 'taxi_trade_eligibility' END;
        v_error:=format('%s: the %s trade rule blocks %s. Move %s to Regular before offering this trade.',v_team.team_name,CASE WHEN v_item.is_on_ir THEN 'IR' ELSE 'taxi' END,v_item.display_name,v_item.display_name);
      END IF;
      IF v_rule IS NOT NULL THEN v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'playerId',v_item."playerId",'message',v_error,
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','move_before_trade','playerId',v_item."playerId",'destination','active','message',format('Move %s to Regular before offering.',v_item.display_name))))); END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)
      JOIN roster_players r ON r.league_season_id=p_season_id AND r.player_id=i."playerId"
      WHERE i."toMemberId"=v_team.id AND (COALESCE(i."toIR",false) OR COALESCE(v_plan->'irPlayerIds','[]') ? i."playerId"::text)
        AND (r.is_on_taxi OR COALESCE(i."toTaxi",false) OR COALESCE(v_plan->'taxiPlayerIds','[]') ? i."playerId"::text)) THEN
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','destination_slot',
        'message',format('%s: an incoming player cannot use both IR and taxi. Traded taxi players stay on taxi.',v_team.team_name),
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','change_destination','destination','taxi','message','Keep the taxi destination and remove the IR choice.'))));
    END IF;
    FOR v_move IN SELECT value FROM jsonb_array_elements(COALESCE(v_plan->'rosterMoves','[]')) UNION ALL
      SELECT jsonb_build_object('playerId',value,'destination','drop') FROM jsonb_array_elements_text(COALESCE(v_plan->'dropPlayerIds','[]'))
    LOOP
      IF v_move->>'destination'='taxi' THEN
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','taxi_incoming_only','playerId',v_move->>'playerId',
          'message','Only incoming players can be placed on Taxi.','suggestedMoves',jsonb_build_array(jsonb_build_object('action','remove_move','playerId',v_move->>'playerId','message','Remove this planned move.'))));
      END IF;
      IF NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id AND player_id=(v_move->>'playerId')::uuid)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) WHERE value->>'playerId'=v_move->>'playerId') OR v_unavailable ? (v_move->>'playerId') THEN
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','planned_move','playerId',v_move->>'playerId',
          'message',format('%s: a planned move uses a missing, offered, or reserved player. Choose another player.',v_team.team_name),'suggestedMoves',jsonb_build_array(jsonb_build_object('action','remove_move','playerId',v_move->>'playerId','message','Remove this planned move.'))));
      END IF;
    END LOOP;
    SELECT count(*),count(*) FILTER(WHERE value->>'location'='active'),count(*) FILTER(WHERE value->>'location'='ir'),count(*) FILTER(WHERE value->>'location'='taxi')
      INTO v_total,v_active,v_ir,v_taxi FROM jsonb_array_elements(v_roster);
    SELECT string_agg(p.display_name,', ') INTO v_ir_out FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid)
      JOIN roster_players r ON r.player_id=i."playerId" AND r.league_season_id=p_season_id AND r.member_id=v_team.id AND r.is_on_ir
      JOIN players p ON p.id=r.player_id WHERE i."fromMemberId"=v_team.id;
    FOR v_location,v_count,v_limit,v_rule,v_name IN SELECT * FROM (VALUES
      ('total',v_total,v_league.roster_size+v_league.ir_slots+v_league.taxi_slots,'roster_size','total roster'),
      ('active',v_active,v_league.roster_size,'active_slots','Regular roster'),('ir',v_ir,v_league.ir_slots,'ir_limit','IR'),('taxi',v_taxi,v_league.taxi_slots,'taxi_limit','taxi')) rules
    LOOP
      v_excess:=v_count-v_limit;
      IF v_excess<=0 THEN CONTINUE; END IF;
      v_suggestions:='[]';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('action','drop','playerId',value->>'playerId','playerName',value->>'name','count',v_excess,
        'message',format('Drop %s.',value->>'name'))),'[]') INTO v_suggestions FROM jsonb_array_elements(v_roster)
        WHERE NOT (value->>'incoming')::boolean AND NOT v_unavailable ? (value->>'playerId') AND (v_location='total' OR value->>'location'=v_location);
      IF v_location<>'total' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('action','move','playerId',r.value->>'playerId','playerName',r.value->>'name','destination',d.location,
          'message',format('Move %s to %s.',r.value->>'name',CASE WHEN d.location='active' THEN 'Regular' ELSE upper(d.location) END))),'[]')||v_suggestions INTO v_suggestions
        FROM jsonb_array_elements(v_roster) r CROSS JOIN (VALUES('active',v_league.roster_size-v_active),('ir',v_league.ir_slots-v_ir),('taxi',v_league.taxi_slots-v_taxi)) d(location,free)
        WHERE r.value->>'location'=v_location AND d.location<>v_location AND d.free>0 AND NOT v_unavailable ? (r.value->>'playerId')
          AND NOT COALESCE(v_destinations->(r.value->>'playerId'),'{}') ? d.location
          AND NOT (d.location<>'taxi' AND EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND player_id=(r.value->>'playerId')::uuid AND is_on_taxi) AND (r.value->>'incoming')::boolean);
      END IF;
      IF jsonb_array_length(v_suggestions)=0 THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('action','remove_incoming','playerId',value->>'playerId','count',v_excess,
          'message',format('Remove %s from the trade.',value->>'name'))),'[]') INTO v_suggestions
          FROM jsonb_array_elements(v_roster) WHERE (value->>'incoming')::boolean AND (v_location='total' OR value->>'location'=v_location);
      END IF;
      v_error:=format('%s: %s is %s over the limit of %s. Drop %s %s or change the listed placements.',v_team.team_name,v_name,v_excess,v_limit,v_excess,CASE WHEN v_excess=1 THEN 'player' ELSE 'players' END);
      SELECT rtrim(value->>'message','.') INTO v_fix FROM jsonb_array_elements(v_suggestions) WHERE value->>'action'='move' LIMIT 1;
      IF v_excess=1 AND v_fix IS NOT NULL THEN
        v_error:=format('%s: %s is 1 over the limit of %s. Drop 1 player or %s.',v_team.team_name,v_name,v_limit,lower(left(v_fix,1))||substr(v_fix,2));
      END IF;
      IF v_location='active' AND v_ir_out IS NOT NULL THEN v_error:=v_error||format(' Trading %s from IR does not free a Regular slot.',v_ir_out); END IF;
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'count',v_excess,'limit',v_limit,'message',v_error,'suggestedMoves',v_suggestions));
    END LOOP;
    SELECT COALESCE(sum((value->>'faabAmount')::int),0) INTO v_cost FROM jsonb_array_elements(p_items) WHERE value->>'fromMemberId'=v_team.id::text;
    v_available:=private.available_faab_balance(p_league_id,p_season_id,v_team.id,p_trade_id);
    IF v_cost>v_available THEN v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','budget','count',v_cost-v_available,
      'message',format('%s: the budget is short by %s FAAB. Reduce the offered FAAB by %s.',v_team.team_name,v_cost-v_available,v_cost-v_available),
      'suggestedMoves',jsonb_build_array(jsonb_build_object('action','reduce_faab','amount',v_cost-v_available,'message',format('Reduce offered FAAB by %s.',v_cost-v_available))))); END IF;
    IF EXISTS(
      WITH commitments AS (
        SELECT t.id,p.drop_player_ids,p.roster_moves FROM trades t JOIN trade_participants p ON p.trade_id=t.id
        WHERE t.league_season_id=p_season_id AND p.member_id=v_team.id AND t.status='accepted' AND t.id IS DISTINCT FROM p_trade_id
      ), resulting AS (
        SELECT COALESCE(m.value->>'destination',r.value->>'location') location
        FROM jsonb_array_elements(v_roster) r LEFT JOIN LATERAL (
          SELECT value FROM commitments,jsonb_array_elements(roster_moves) WHERE value->>'playerId'=r.value->>'playerId'
        ) m ON true
        WHERE NOT EXISTS(SELECT 1 FROM commitments WHERE (r.value->>'playerId')::uuid=ANY(drop_player_ids))
          AND NOT EXISTS(SELECT 1 FROM commitments c JOIN trade_items i ON i.trade_id=c.id WHERE i.from_member_id=v_team.id AND i.player_id=(r.value->>'playerId')::uuid)
        UNION ALL
        SELECT CASE WHEN i.to_taxi OR r.is_on_taxi THEN 'taxi' WHEN i.to_ir THEN 'ir' ELSE 'active' END
        FROM commitments c JOIN trade_items i ON i.trade_id=c.id AND i.to_member_id=v_team.id
        JOIN roster_players r ON r.league_season_id=p_season_id AND r.player_id=i.player_id
      ) SELECT 1 FROM resulting HAVING count(*) FILTER(WHERE location='active')>v_league.roster_size
        OR count(*) FILTER(WHERE location='ir')>v_league.ir_slots OR count(*) FILTER(WHERE location='taxi')>v_league.taxi_slots
    ) AND jsonb_array_length(v_reasons)=0 THEN
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','reserved_capacity',
        'message',format('%s: accepted trades reserve these roster slots. Add a drop or choose an eligible open slot.',v_team.team_name),
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','change_plan','message','Add a drop or resolve another accepted trade.'))));
    END IF;
    SELECT string_agg(value->>'message',' ') INTO v_error FROM jsonb_array_elements(v_reasons);
    v_teams:=v_teams||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'roster',v_roster,'drops',v_drops,'moves',COALESCE(v_plan->'rosterMoves','[]'),
      'plan',v_plan,'limits',jsonb_build_object('active',v_league.roster_size,'ir',v_league.ir_slots,'taxi',v_league.taxi_slots),'reasons',v_reasons,'legal',jsonb_array_length(v_reasons)=0,
      'error',v_error,'unavailableMoves',v_unavailable,'unavailableDestinations',v_destinations));
  END LOOP;
  RETURN v_teams;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[], p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  __request_context := private.request_begin('public.set_trade_roster_plan_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id, p_taxi_player_ids, p_ir_player_ids, p_drop_player_ids, p_roster_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE v_trade trades%ROWTYPE; v_member uuid; v_player uuid; v_all uuid[]; v_preview jsonb;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_participants participant JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id AND member.id = p_member_id AND member.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Only the receiving manager can choose placements and drops.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_roster_moves) IS DISTINCT FROM 'array' OR jsonb_array_length(p_roster_moves)>100 THEN
    RAISE EXCEPTION 'Roster moves must be an array of at most 100 players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE jsonb_typeof(move) IS DISTINCT FROM 'object'
    OR move->>'destination' IS NULL OR move->>'destination' NOT IN ('active','ir','taxi')
    OR move->>'playerId' IS NULL OR move->>'playerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Each roster move requires a player and a Regular, IR, or taxi destination.' USING ERRCODE='22023';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(p_roster_moves) move);
  IF p_taxi_player_ids IS NULL OR p_ir_player_ids IS NULL OR p_drop_player_ids IS NULL
    OR cardinality(v_all) > 100 OR EXISTS (SELECT 1 FROM unnest(v_all) id GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Placements and drops must be unique players.' USING ERRCODE = '22023';
  END IF;
  FOR v_member IN SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id ORDER BY member_id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
    END IF;
  END LOOP;
  FOR v_player IN SELECT DISTINCT id FROM (
    SELECT unnest(v_all) id UNION SELECT player_id FROM trade_items WHERE trade_id = p_trade_id
  ) ids WHERE id IS NOT NULL ORDER BY id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
    END IF;
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id AND (status='pending' OR status='accepted' AND jsonb_array_length(legality_issues)>0) FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND OR v_trade.status NOT IN ('pending','accepted') OR v_trade.status='pending' AND v_trade.expires_at <= now() THEN
    RAISE EXCEPTION 'Choose placements and drops while the trade is pending.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE move->>'destination'='taxi') THEN
    RAISE EXCEPTION 'Only incoming players can be placed on Taxi.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INCOMING_ONLY';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids) choice(player_id)
    WHERE NOT private.taxi_player_eligible(v_trade.league_id,choice.player_id)) THEN
    RAISE EXCEPTION 'Taxi requires a rookie or fewer than 65 known career games.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INELIGIBLE';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids || p_ir_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Placements must belong to incoming players.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_drop_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND member_id = p_member_id AND player_id = choice.player_id)
    OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Drop choices must be your rostered players outside this offer.';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id AND player_id=ANY(p_ir_player_ids) AND is_on_taxi) THEN
    RAISE EXCEPTION 'Traded taxi players must remain on taxi with their original tenure.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move
    WHERE NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id
      AND roster.member_id=p_member_id AND roster.player_id=(move->>'playerId')::uuid)
      OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND player_id=(move->>'playerId')::uuid)) THEN
    RAISE EXCEPTION 'Moves must be retained players from your own roster.' USING ERRCODE='22023';
  END IF;
  UPDATE trade_items item SET to_taxi = item.player_id = ANY(p_taxi_player_ids) OR EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND player_id = item.player_id AND is_on_taxi),
    to_ir = item.player_id = ANY(p_ir_player_ids)
  WHERE item.trade_id = p_trade_id AND item.to_member_id = p_member_id AND item.player_id IS NOT NULL;
  UPDATE trade_participants SET drop_player_ids = p_drop_player_ids, roster_moves=p_roster_moves WHERE trade_id = p_trade_id AND member_id = p_member_id;
  IF v_trade.status='accepted' AND jsonb_array_length(v_trade.legality_issues)>0 THEN
    v_preview:=public.get_trade_roster_preview(p_trade_id,p_user_id);
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview) team WHERE NOT (team->>'legal')::boolean) THEN
      PERFORM public.hold_trade_for_legality_atomic(p_trade_id,NULL);
    ELSE
      UPDATE trades SET legality_issues='[]',completion_failure_reason=NULL WHERE id=p_trade_id;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM trade_participants WHERE trade_id=p_trade_id AND member_id=p_member_id AND accepted_at IS NOT NULL) THEN
    PERFORM private.validate_trade_rosters(p_trade_id, p_member_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
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
  v_previous_applied_trade text;
  v_drop record;
  v_move record;
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
      UNION SELECT (move->>'playerId')::uuid FROM trade_participants,jsonb_array_elements(roster_moves) move WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR NO KEY UPDATE NOWAIT;

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
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM trade_participants participant CROSS JOIN LATERAL jsonb_array_elements(participant.roster_moves) move
    WHERE participant.trade_id=p_trade_id AND move->>'destination'='taxi') THEN
    RAISE EXCEPTION 'Only incoming players can be placed on Taxi.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INCOMING_ONLY';
  END IF;

  BEGIN
    PERFORM private.validate_trade_rosters(p_trade_id);
  EXCEPTION WHEN SQLSTATE 'PT001' OR SQLSTATE 'PT409' THEN
    PERFORM public.hold_trade_for_legality_atomic(p_trade_id,NULL);
    RETURN;
  END;

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
  v_previous_applied_trade:=COALESCE(current_setting('pancake.applied_trade_id',true),'');
  PERFORM set_config('pancake.applied_trade_id',p_trade_id::text,true);
    FOR v_drop IN SELECT roster.* FROM trade_participants participant JOIN roster_players roster
      ON roster.member_id=participant.member_id AND roster.league_season_id=v_trade.league_season_id
        AND roster.player_id=ANY(participant.drop_player_ids)
      WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
    LOOP
      PERFORM private.release_roster_player_to_waivers(v_drop.id,v_trade.league_id,v_trade.league_season_id,
        v_drop.member_id,v_drop.player_id,'drop',NULL,p_trade_id);
    END LOOP;
  FOR v_move IN SELECT roster.id,roster.member_id,roster.player_id,roster.is_on_ir,roster.is_on_taxi,move->>'destination' AS destination
    FROM trade_participants participant CROSS JOIN LATERAL jsonb_array_elements(participant.roster_moves) move
    JOIN roster_players roster ON roster.player_id=(move->>'playerId')::uuid AND roster.member_id=participant.member_id
      AND roster.league_season_id=v_trade.league_season_id
    WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
  LOOP
    IF private.roster_status_game_started(v_move.player_id) THEN
      RAISE EXCEPTION 'A planned roster move waits for the player game slate to end.' USING ERRCODE='PT002';
    END IF;
    PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,'trade',p_trade_id);
    UPDATE roster_players SET is_on_ir=v_move.destination='ir',is_on_taxi=v_move.destination='taxi',
      taxi_start_season_year=CASE WHEN v_move.destination='taxi' THEN private.taxi_start_year(v_trade.league_id,v_move.player_id,(SELECT season_year FROM league_seasons WHERE id=v_trade.league_season_id)) ELSE taxi_start_season_year END WHERE id=v_move.id;
    INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,related_trade_id)
      VALUES(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,
        CASE WHEN v_move.destination='taxi' THEN 'taxi_designate' WHEN v_move.destination='ir' THEN 'ir_designate' WHEN v_move.is_on_taxi THEN 'taxi_return' ELSE 'ir_return' END,p_trade_id);
  END LOOP;

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
      PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
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
         completion_failure_reason = NULL,
         legality_issues = '[]'
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  FOR v_member_lock IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM private.assert_accepted_trade_capacity(v_trade.league_id,v_trade.league_season_id,v_member_lock);
  END LOOP;
  PERFORM set_config('pancake.applied_trade_id',v_previous_applied_trade,true);
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
