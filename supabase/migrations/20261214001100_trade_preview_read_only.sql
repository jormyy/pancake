BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE OR REPLACE FUNCTION private.read_available_faab_balance(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS int
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT balance FROM public.faab_balances WHERE league_id=p_league_id
      AND league_season_id=p_league_season_id AND member_id=p_member_id),
    (SELECT faab_starting_budget FROM public.leagues WHERE id=p_league_id),100)
    - COALESCE((SELECT sum(item.faab_amount)::int
      FROM public.trade_items item JOIN public.trades trade ON trade.id=item.trade_id
      WHERE trade.league_id=p_league_id AND trade.league_season_id=p_league_season_id
        AND trade.status='accepted' AND item.from_member_id=p_member_id
        AND trade.id IS DISTINCT FROM p_exclude_trade_id),0);
$$;
REVOKE ALL ON FUNCTION private.read_available_faab_balance(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
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
    v_available:=private.read_available_faab_balance(p_league_id,p_season_id,v_team.id,p_trade_id);
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
CREATE OR REPLACE FUNCTION private.validate_trade_rosters(p_trade_id uuid,p_only_member_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user uuid; v_teams jsonb; v_error text;
BEGIN
  PERFORM 1 FROM leagues WHERE id=(SELECT league_id FROM trades WHERE id=p_trade_id) FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM players WHERE id IN (
    SELECT player_id FROM trade_items WHERE trade_id=p_trade_id UNION
    SELECT r.player_id FROM roster_players r JOIN trade_participants t ON t.member_id=r.member_id
      JOIN trades trade ON trade.id=t.trade_id AND trade.league_season_id=r.league_season_id WHERE t.trade_id=p_trade_id
  ) ORDER BY id FOR SHARE;
  PERFORM private.ensure_faab_balance(trade.league_id,trade.league_season_id,participant.member_id)
    FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE trade.id=p_trade_id ORDER BY participant.sort_order,participant.member_id;
  SELECT m.user_id INTO v_user FROM trades t JOIN league_members m ON m.id=t.proposer_member_id WHERE t.id=p_trade_id;
  v_teams:=public.get_trade_roster_preview(p_trade_id,v_user);
  SELECT string_agg(reason->>'message',' ') INTO v_error FROM jsonb_array_elements(v_teams) team
    CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason
    WHERE p_only_member_id IS NULL OR team->>'memberId'=p_only_member_id::text;
  IF v_error IS NOT NULL THEN RAISE EXCEPTION '%',v_error USING ERRCODE='PT409',DETAIL=v_teams::text; END IF;
END;
$$;
COMMIT;
