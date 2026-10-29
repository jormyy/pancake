ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS legality_issues jsonb NOT NULL DEFAULT '[]'::jsonb;

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
      v_taxi_error:=CASE WHEN v_league.taxi_slots=0 THEN 'This league has no taxi slots.'
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

CREATE OR REPLACE FUNCTION public.preview_trade_legality(
  p_user_id uuid,p_league_id uuid,p_member_ids uuid[],p_items jsonb,p_plans jsonb DEFAULT '{}',p_trade_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_trade trades%ROWTYPE; v_season uuid; v_members uuid[]; v_items jsonb; v_plans jsonb; v_override record;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM league_members WHERE league_id=p_league_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'You cannot view this trade roster plan.' USING ERRCODE='42501';
  END IF;
  IF p_trade_id IS NOT NULL THEN
    SELECT * INTO STRICT v_trade FROM trades WHERE id=p_trade_id AND league_id=p_league_id;
    v_season:=v_trade.league_season_id;
    SELECT array_agg(member_id ORDER BY sort_order,member_id),jsonb_object_agg(member_id::text,jsonb_build_object('dropPlayerIds',drop_player_ids,'rosterMoves',roster_moves,'irPlayerIds',(SELECT COALESCE(jsonb_agg(player_id),'[]') FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=member_id AND to_ir),'taxiPlayerIds',(SELECT COALESCE(jsonb_agg(player_id),'[]') FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=member_id AND to_taxi)))
      INTO v_members,v_plans FROM trade_participants WHERE trade_id=p_trade_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',player_id,'pickId',pick_id,'fromMemberId',from_member_id,'toMemberId',to_member_id,
      'faabAmount',faab_amount,'toIR',to_ir,'toTaxi',to_taxi)),'[]') INTO v_items FROM trade_items WHERE trade_id=p_trade_id;
  ELSE
    SELECT id INTO STRICT v_season FROM league_seasons WHERE league_id=p_league_id AND is_current;
    v_members:=p_member_ids; v_items:=p_items; v_plans:='{}';
  END IF;
  IF jsonb_typeof(p_plans) IS DISTINCT FROM 'object' OR jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR cardinality(v_members) NOT BETWEEN 2 AND 12 THEN
    RAISE EXCEPTION 'Trade teams, items, and roster plans are required.' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM league_members WHERE league_id=p_league_id AND id=ANY(v_members))<>cardinality(v_members) THEN
    RAISE EXCEPTION 'Trade teams must belong to this league.' USING ERRCODE='22023';
  END IF;
  FOR v_override IN SELECT * FROM jsonb_each(p_plans) LOOP
    IF NOT v_override.key::uuid=ANY(v_members) THEN RAISE EXCEPTION 'Roster plan team is not in this trade.' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS(SELECT 1 FROM league_members WHERE id=v_override.key::uuid AND user_id=p_user_id)
      AND (p_trade_id IS NOT NULL OR jsonb_array_length(COALESCE(v_override.value->'dropPlayerIds','[]'))>0 OR jsonb_array_length(COALESCE(v_override.value->'rosterMoves','[]'))>0) THEN
      RAISE EXCEPTION 'Only a team manager can choose its drops and moves.' USING ERRCODE='42501';
    END IF;
    v_plans:=v_plans||jsonb_build_object(v_override.key,v_override.value);
    SELECT COALESCE(jsonb_agg(CASE WHEN value->>'toMemberId'=v_override.key THEN value||jsonb_build_object('toIR',false,'toTaxi',false) ELSE value END),'[]')
      INTO v_items FROM jsonb_array_elements(v_items);
  END LOOP;
  RETURN private.check_trade_legality(p_league_id,v_season,v_members,v_items,v_plans,p_trade_id);
END;
$$;

-- Canonical SQL source for private.accept_trade_participant_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.accept_trade_participant_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_all_accepted boolean;
  v_veto_window_hours int;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  -- Read first, lock parties and players in the order every roster mutation
  -- uses, then lock the trade row: a drop that expires this offer holds the
  -- member and player locks while it updates the trade, so taking the trade
  -- row first would deadlock against it.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;


  PERFORM 1
    FROM trade_participants
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a trade participant can accept this trade.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND member_id = p_accepting_member_id
       AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This participant has already accepted the trade.'
      USING ERRCODE = 'P0001';
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
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
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
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
    END IF;
  END LOOP;

  -- Accepted completion owns its trade row before team locks. A stale pending
  -- action must not wait on that row while holding its team locks.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status
     WHERE id = p_trade_id AND status = 'pending'::trade_status;
    RETURN jsonb_build_object(
      'expired', true,
      'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
      'allAccepted', false,
      'proposerMemberId', v_trade.proposer_member_id,
      'recipientMemberId', v_trade.recipient_member_id,
      'participantMemberIds', (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      )
    );
  END IF;


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


  PERFORM private.assert_trade_window(v_trade.league_id,
    ARRAY(SELECT pick_id FROM trade_items WHERE trade_id=p_trade_id AND pick_id IS NOT NULL));

  SELECT NOT EXISTS (SELECT 1 FROM trade_participants
    WHERE trade_id=p_trade_id AND member_id<>p_accepting_member_id AND accepted_at IS NULL)
    INTO v_all_accepted;

  PERFORM private.assert_trade_assets_acceptance_ready(
    p_trade_id,
    v_trade.league_id,
    v_trade.league_season_id,
    NULL
  );

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NULL
       AND item.pick_id IS NULL
       AND COALESCE(item.faab_amount, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount';
  END IF;

  UPDATE trade_participants
     SET accepted_at = now()
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
     AND accepted_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record participant acceptance.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND accepted_at IS NULL
  )
    INTO v_all_accepted;

  IF v_all_accepted THEN
    v_veto_window_hours := CASE
      WHEN COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN 0
      ELSE LEAST(GREATEST(COALESCE(v_league.trade_veto_window_hours, 24), 0), 168)
    END;

    UPDATE trades
       SET status = 'accepted',
           accepted_at = now(),
           veto_window_expires_at = CASE
             WHEN v_veto_window_hours = 0 THEN now() - interval '1 microsecond'
             ELSE now() + make_interval(hours => v_veto_window_hours)
           END,
           completed_at = NULL,
           vetoed_at = NULL
     WHERE id = p_trade_id
       AND status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to accept trade atomically';
    END IF;

  END IF;

  IF v_all_accepted THEN
    PERFORM private.work_enqueue('trade-activation',p_trade_id::text,now(),jsonb_build_object('tradeId',p_trade_id));
  END IF;

  RETURN jsonb_build_object(
    'expired', false,
    'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
    'allAccepted', v_all_accepted,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', (
      SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
    )
  );
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_accepted_trade_capacity(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_include_trade_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_counts record; v_league leagues%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND participant.member_id=p_member_id
      AND (trade.status='accepted' OR trade.id=p_include_trade_id)) THEN RETURN; END IF;
  SELECT * INTO v_league FROM leagues WHERE id=p_league_id;
  WITH commitments AS (
    SELECT trade.id,participant.drop_player_ids,participant.roster_moves
    FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id AND participant.member_id=p_member_id
    WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND (trade.status='accepted' OR trade.id=p_include_trade_id)
  ), resulting AS (
    SELECT CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination'='ir' END AS on_ir,
      CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE move.value->>'destination'='taxi' END AS on_taxi
    FROM roster_players roster
    LEFT JOIN LATERAL (SELECT value FROM commitments,jsonb_array_elements(roster_moves) WHERE value->>'playerId'=roster.player_id::text) move ON true
    WHERE roster.league_season_id=p_season_id AND roster.member_id=p_member_id
      AND NOT EXISTS (SELECT 1 FROM commitments WHERE roster.player_id=ANY(drop_player_ids))
      AND NOT EXISTS (SELECT 1 FROM commitments JOIN trade_items item ON item.trade_id=commitments.id
        WHERE item.from_member_id=p_member_id AND item.player_id=roster.player_id)
    UNION ALL
    SELECT item.to_ir,item.to_taxi OR roster.is_on_taxi
    FROM commitments JOIN trade_items item ON item.trade_id=commitments.id AND item.to_member_id=p_member_id
    JOIN roster_players roster ON roster.league_season_id=p_season_id AND roster.player_id=item.player_id
  ) SELECT count(*) FILTER(WHERE NOT on_ir AND NOT on_taxi) active,count(*) FILTER(WHERE on_ir) ir,
      count(*) FILTER(WHERE on_taxi) taxi INTO v_counts FROM resulting;
  IF v_counts.active>v_league.roster_size OR v_counts.ir>v_league.ir_slots OR v_counts.taxi>v_league.taxi_slots THEN
    RAISE EXCEPTION 'Accepted trades reserve roster capacity. Change this action or resolve the trade first.' USING ERRCODE='PT409';
  END IF;
END;
$$;

-- Canonical SQL source for private.create_multi_team_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.create_multi_team_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_parent_trade_id uuid DEFAULT NULL,
  p_countered_from_trade_id uuid DEFAULT NULL,
  p_edited_from_trade_id uuid DEFAULT NULL,
  p_version int DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_league leagues%ROWTYPE;
  v_rows int;
  v_participant_count int;
  v_first_recipient_member_id uuid;
  v_balance int;
  v_faab record;
  v_champion_finalized boolean := false;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Multi-team trade items must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'A multi-team trade must include between 1 and 100 items.'
      USING ERRCODE = '22023';
  END IF;

  IF octet_length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Trade notes must not exceed 2000 bytes.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)
    INTO v_participant_count
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids);
  IF v_participant_count < 3 THEN
    RAISE EXCEPTION 'A multi-team trade requires at least 3 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF v_participant_count > 12 THEN
    RAISE EXCEPTION 'A multi-team trade cannot include more than 12 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE from_member_id = to_member_id
        OR faab_amount < 0
        OR ((player_id IS NOT NULL)::int + (pick_id IS NOT NULL)::int + (faab_amount > 0)::int) <> 1
  ) THEN
    RAISE EXCEPTION 'Each multi-team trade item must route exactly one player, pick, or positive FAAB amount between two different teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items) AS item
     WHERE NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.from_member_id
     )
        OR NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.to_member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every item source and destination must be a trade participant.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
     WHERE NOT EXISTS (
       SELECT 1
         FROM private.parse_multi_team_trade_items(p_items) AS item
        WHERE item.from_member_id = participant.member_id
           OR item.to_member_id = participant.member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every participating team must send or receive at least one asset.'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) <>
     (SELECT count(DISTINCT player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded players are not allowed.';
  END IF;

  IF (SELECT count(pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) <>
     (SELECT count(DISTINCT pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded picks are not allowed.';
  END IF;

  PERFORM private.lock_trade_offer_assets(
    p_league_id,
    ARRAY(SELECT member_id FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)),
    ARRAY(SELECT player_id FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL)
  );

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
      JOIN league_seasons AS season
        ON season.id = matchup.league_season_id
       AND season.is_current = true
     WHERE matchup.league_id = p_league_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  PERFORM private.assert_trade_window(p_league_id, ARRAY(SELECT pick_id FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL));

  IF v_league.status NOT IN (
    'drafting'::league_status,
    'active'::league_status,
    'playoffs'::league_status,
    'offseason'::league_status
  ) THEN
    RAISE EXCEPTION 'Trades are not allowed for this league right now.';
  END IF;

  IF v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league.status = 'active'::league_status
       OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.';
    END IF;
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF (v_league.status = 'active'::league_status
        OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized))
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM private.parse_multi_team_trade_items(p_items) WHERE faab_amount > 0)
     AND v_league.waiver_mode <> 'faab' THEN
    RAISE EXCEPTION 'FAAB can only be traded in FAAB waiver leagues.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;


  SELECT count(*)
    INTO v_rows
    FROM league_members AS member
    JOIN private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
      ON participant.member_id = member.id
   WHERE member.league_id = p_league_id;

  IF v_rows <> v_participant_count THEN
    RAISE EXCEPTION 'Every trade participant must be a member of this league.';
  END IF;

  WITH locked AS (
    SELECT item.player_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN roster_players AS roster
        ON roster.league_id = p_league_id
       AND roster.league_season_id = p_league_season_id
       AND roster.member_id = item.from_member_id
       AND roster.player_id = item.player_id
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (roster.is_on_ir = false AND roster.is_on_taxi = false))
     WHERE item.player_id IS NOT NULL
     FOR SHARE OF roster
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A player asset is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT item.pick_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN draft_picks AS pick
        ON pick.id = item.pick_id
       AND pick.league_id = p_league_id
       AND pick.current_owner_id = item.from_member_id
       AND pick.is_used = false
     WHERE item.pick_id IS NOT NULL
     FOR SHARE OF pick
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A draft pick asset is no longer owned by the expected team.';
  END IF;

  FOR v_faab IN
    SELECT from_member_id, sum(faab_amount)::int AS amount
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE faab_amount > 0
     GROUP BY from_member_id
  LOOP
    v_balance := private.available_faab_balance(p_league_id, p_league_season_id, v_faab.from_member_id);
    IF v_balance < v_faab.amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds a participant''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT member_id
    INTO v_first_recipient_member_id
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
   WHERE member_id <> p_proposer_member_id
   ORDER BY sort_order, member_id
   LIMIT 1;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    is_multi_team,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    true,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    p_version
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_participants (
    trade_id,
    member_id,
    sort_order,
    is_initiator,
    accepted_at
  )
  SELECT
    v_trade_id,
    member_id,
    sort_order,
    member_id = p_proposer_member_id,
    CASE WHEN member_id = p_proposer_member_id THEN now() ELSE NULL END
  FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
  ORDER BY sort_order, member_id;

  INSERT INTO trade_items (
    trade_id,
    side,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  )
  SELECT
    v_trade_id,
    CASE WHEN from_member_id = p_proposer_member_id THEN 'proposer'::trade_side ELSE 'recipient'::trade_side END,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  FROM private.parse_multi_team_trade_items(p_items)
  ORDER BY sort_order;

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    'trade_offered',
    'Multi-team trade offer sent',
    NULL,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'is_multi_team', true,
      'participant_count', v_participant_count,
      'item_count', jsonb_array_length(p_items)
    )
  );

  RETURN v_trade_id;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
END;
$$;

-- Canonical SQL source for private.create_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.create_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0,
  p_parent_trade_id uuid DEFAULT NULL,
  p_countered_from_trade_id uuid DEFAULT NULL,
  p_edited_from_trade_id uuid DEFAULT NULL,
  p_version int DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_offer_player_ids uuid[] := COALESCE(p_offer_player_ids, ARRAY[]::uuid[]);
  v_request_player_ids uuid[] := COALESCE(p_request_player_ids, ARRAY[]::uuid[]);
  v_offer_pick_ids uuid[] := COALESCE(p_offer_pick_ids, ARRAY[]::uuid[]);
  v_request_pick_ids uuid[] := COALESCE(p_request_pick_ids, ARRAY[]::uuid[]);
  v_offer_faab_amount int := COALESCE(p_offer_faab_amount, 0);
  v_request_faab_amount int := COALESCE(p_request_faab_amount, 0);
  v_rows int;
  v_league leagues%ROWTYPE;
  v_balance int;
  v_terms jsonb;
  v_champion_finalized boolean := false;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  IF cardinality(v_offer_player_ids) + cardinality(v_request_player_ids) +
     cardinality(v_offer_pick_ids) + cardinality(v_request_pick_ids) +
     (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) +
     (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) > 100 THEN
    RAISE EXCEPTION 'A trade cannot include more than 100 items.'
      USING ERRCODE = '22023';
  END IF;

  IF octet_length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Trade notes must not exceed 2000 bytes.'
      USING ERRCODE = '22023';
  END IF;

  IF p_proposer_member_id = p_recipient_member_id THEN
    RAISE EXCEPTION 'You cannot trade with yourself.';
  END IF;

  IF v_offer_faab_amount < 0 OR v_offer_faab_amount > 1000000 OR
     v_request_faab_amount < 0 OR v_request_faab_amount > 1000000 THEN
    RAISE EXCEPTION 'FAAB trade amounts must be between 0 and 1000000.'
      USING ERRCODE = '22023';
  END IF;

  IF cardinality(v_offer_player_ids) + cardinality(v_offer_pick_ids) + (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) = 0 OR
     cardinality(v_request_player_ids) + cardinality(v_request_pick_ids) + (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) = 0 THEN
    RAISE EXCEPTION 'A trade must include at least one asset on each side.';
  END IF;

  IF (SELECT count(*) FROM unnest(v_offer_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_offer_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered picks are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested picks are not allowed.';
  END IF;

  PERFORM private.lock_trade_offer_assets(
    p_league_id,
    ARRAY[p_proposer_member_id, p_recipient_member_id],
    v_offer_player_ids || v_request_player_ids
  );

  SELECT private.canonical_trade_estimate_terms(jsonb_agg(jsonb_build_object(
    'fromMemberId',route.sender,'toMemberId',route.receiver,'playerId',route.player_id,
    'pickId',route.pick_id,'faabAmount',route.faab_amount))) INTO v_terms
  FROM (
    SELECT p_proposer_member_id sender,p_recipient_member_id receiver,player_id,NULL::uuid pick_id,0 faab_amount FROM unnest(v_offer_player_ids) player_id
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,player_id,NULL::uuid,0 FROM unnest(v_request_player_ids) player_id
    UNION ALL SELECT p_proposer_member_id,p_recipient_member_id,NULL::uuid,pick_id,0 FROM unnest(v_offer_pick_ids) pick_id
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,NULL::uuid,pick_id,0 FROM unnest(v_request_pick_ids) pick_id
    UNION ALL SELECT p_proposer_member_id,p_recipient_member_id,NULL::uuid,NULL::uuid,v_offer_faab_amount WHERE v_offer_faab_amount>0
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,NULL::uuid,NULL::uuid,v_request_faab_amount WHERE v_request_faab_amount>0
  ) route;
  IF EXISTS(SELECT 1 FROM trades pending WHERE pending.league_id=p_league_id
    AND pending.league_season_id=p_league_season_id AND pending.status='pending'
    AND (pending.expires_at IS NULL OR pending.expires_at>now())
    AND pending.proposer_member_id=p_proposer_member_id AND pending.recipient_member_id=p_recipient_member_id
    AND pending.id IS DISTINCT FROM p_edited_from_trade_id AND pending.id IS DISTINCT FROM p_countered_from_trade_id
    AND v_terms=(SELECT private.canonical_trade_estimate_terms(jsonb_agg(jsonb_build_object(
      'fromMemberId',item.from_member_id,'toMemberId',item.to_member_id,'playerId',item.player_id,
      'pickId',item.pick_id,'faabAmount',item.faab_amount))) FROM trade_items item WHERE item.trade_id=pending.id)) THEN
    RAISE EXCEPTION 'An identical offer is already pending. Open that trade instead.' USING ERRCODE='P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
      JOIN league_seasons AS season
        ON season.id = matchup.league_season_id
       AND season.is_current = true
     WHERE matchup.league_id = p_league_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  PERFORM private.assert_trade_window(p_league_id, v_offer_pick_ids || v_request_pick_ids);

  IF v_league.status NOT IN (
    'drafting'::league_status,
    'active'::league_status,
    'playoffs'::league_status,
    'offseason'::league_status
  ) THEN
    RAISE EXCEPTION 'Trades are not allowed for this league right now.';
  END IF;

  IF v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league.status = 'active'::league_status
       OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.';
    END IF;
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF (v_league.status = 'active'::league_status
        OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized))
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF (v_offer_faab_amount > 0 OR v_request_faab_amount > 0) AND v_league.waiver_mode <> 'faab' THEN
    RAISE EXCEPTION 'FAAB can only be traded in FAAB waiver leagues.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;


  PERFORM 1
    FROM league_members
   WHERE id = p_proposer_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposer not found.';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_recipient_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient not found.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_proposer_member_id
       AND player_id = ANY(v_offer_player_ids)
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (is_on_ir = false AND is_on_taxi = false))
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_player_ids) THEN
    RAISE EXCEPTION 'Your offer includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_recipient_member_id
       AND player_id = ANY(v_request_player_ids)
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (is_on_ir = false AND is_on_taxi = false))
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_player_ids) THEN
    RAISE EXCEPTION 'Your request includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_proposer_member_id
       AND is_used = false
       AND id = ANY(v_offer_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_pick_ids) THEN
    RAISE EXCEPTION 'Your offer includes a draft pick that is no longer owned by the expected team.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_recipient_member_id
       AND is_used = false
       AND id = ANY(v_request_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_pick_ids) THEN
    RAISE EXCEPTION 'Your request includes a draft pick that is no longer owned by the expected team.';
  END IF;

  IF v_offer_faab_amount > 0 THEN
    v_balance := private.available_faab_balance(p_league_id, p_league_season_id, p_proposer_member_id);
    IF v_balance < v_offer_faab_amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds the proposer''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_request_faab_amount > 0 THEN
    v_balance := private.available_faab_balance(p_league_id, p_league_season_id, p_recipient_member_id);
    IF v_balance < v_request_faab_amount THEN
      RAISE EXCEPTION 'Requested FAAB exceeds the recipient''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version,
    proposer_faab_amount,
    recipient_faab_amount
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    GREATEST(COALESCE(p_version, 1), 1),
    v_offer_faab_amount,
    v_request_faab_amount
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_items (trade_id, side, player_id, pick_id, from_member_id, to_member_id, faab_amount)
  SELECT v_trade_id, 'proposer'::trade_side, player_id, NULL::uuid, p_proposer_member_id, p_recipient_member_id, 0
    FROM unnest(v_offer_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, player_id, NULL::uuid, p_recipient_member_id, p_proposer_member_id, 0
    FROM unnest(v_request_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, pick_id, p_proposer_member_id, p_recipient_member_id, 0
    FROM unnest(v_offer_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, pick_id, p_recipient_member_id, p_proposer_member_id, 0
    FROM unnest(v_request_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, NULL::uuid, p_proposer_member_id, p_recipient_member_id, v_offer_faab_amount
   WHERE v_offer_faab_amount > 0
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, NULL::uuid, p_recipient_member_id, p_proposer_member_id, v_request_faab_amount
   WHERE v_request_faab_amount > 0;

  INSERT INTO trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
  VALUES
    (v_trade_id, p_proposer_member_id, 0, true, now()),
    (v_trade_id, p_recipient_member_id, 1, false, NULL);

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'trade_edited'
      ELSE 'trade_offered'
    END,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'Counteroffer sent'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'Trade offer edited'
      ELSE 'Trade offer sent'
    END,
    NULL,
    p_proposer_member_id,
    p_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'parent_trade_id', p_parent_trade_id,
      'countered_from_trade_id', p_countered_from_trade_id,
      'edited_from_trade_id', p_edited_from_trade_id,
      'version', GREATEST(COALESCE(p_version, 1), 1),
      'proposer_faab_amount', v_offer_faab_amount,
      'recipient_faab_amount', v_request_faab_amount
    )
  );

  RETURN v_trade_id;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
END;
$$;

-- Canonical SQL source for private.prevent_accepted_or_inactive_roster_move.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_completing_trade_id uuid;
  v_applied_trade_id text:=current_setting('pancake.applied_trade_id',true);
BEGIN
  IF OLD.member_id<>NEW.member_id THEN
    SELECT c.related_id INTO v_completing_trade_id FROM private.taxi_acquisition_context c
    JOIN trades t ON t.id=c.related_id AND t.status='accepted' AND t.id::text=v_applied_trade_id
    JOIN trade_items i ON i.trade_id=t.id AND i.player_id=NEW.player_id
      AND i.from_member_id=OLD.member_id AND i.to_member_id=NEW.member_id
      AND i.to_ir=NEW.is_on_ir AND (i.to_taxi OR OLD.is_on_taxi)=NEW.is_on_taxi
    WHERE c.transaction_id=pg_current_xact_id() AND c.source='trade'
      AND c.league_id=NEW.league_id AND c.league_season_id=NEW.league_season_id
      AND c.member_id=NEW.member_id AND c.player_id=NEW.player_id
      AND t.league_id=NEW.league_id AND t.league_season_id=NEW.league_season_id;
  END IF;
  IF OLD.member_id=NEW.member_id THEN
    SELECT trade.id INTO v_completing_trade_id FROM private.taxi_acquisition_context context
    JOIN trades trade ON trade.id=context.related_id JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE context.transaction_id=pg_current_xact_id() AND context.source='trade'
      AND context.league_id=OLD.league_id AND context.league_season_id=OLD.league_season_id
      AND context.member_id=OLD.member_id AND context.player_id=OLD.player_id
      AND trade.status='accepted' AND trade.id::text=v_applied_trade_id
      AND trade.league_id=OLD.league_id AND trade.league_season_id=OLD.league_season_id AND participant.member_id=OLD.member_id
      AND NOT (NEW.is_on_ir AND NEW.is_on_taxi)
      AND participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',OLD.player_id::text,
        'destination',CASE WHEN NEW.is_on_taxi THEN 'taxi' WHEN NEW.is_on_ir THEN 'ir' ELSE 'active' END));
  END IF;
  IF OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, v_completing_trade_id);
  END IF;

  IF (
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM waiver_claims AS claim
     WHERE claim.status = 'pending'::waiver_claim_status
       AND claim.league_id = OLD.league_id
       AND claim.league_season_id = OLD.league_season_id
       AND claim.member_id = OLD.member_id
       AND claim.drop_player_id = OLD.player_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as a pending waiver drop.'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.member_id IS DISTINCT FROM NEW.member_id AND v_completing_trade_id IS NULL AND (
    ((OLD.is_on_ir OR OLD.is_on_taxi OR NEW.is_on_ir) AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_id AND allow_inactive_trades)) OR
    (NEW.is_on_taxi = true AND v_completing_trade_id IS NULL AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_id AND allow_inactive_trades))
  ) THEN
    RAISE EXCEPTION 'Inactive roster players must be activated before they can be traded.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.trade_resulting_roster(p_trade_id uuid,p_member_id uuid)
RETURNS TABLE(player_id uuid,on_ir boolean,on_taxi boolean)
LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT roster.player_id,
    CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination'='ir' END,
    CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE move.value->>'destination'='taxi' END
  FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id AND participant.member_id=p_member_id
  JOIN roster_players roster ON roster.league_season_id=trade.league_season_id AND roster.member_id=p_member_id
  LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(participant.roster_moves) WHERE value->>'playerId'=roster.player_id::text) move ON true
  WHERE trade.id=p_trade_id AND NOT roster.player_id=ANY(participant.drop_player_ids)
    AND NOT EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=trade.id AND item.from_member_id=p_member_id AND item.player_id=roster.player_id)
  UNION ALL
  SELECT item.player_id,item.to_ir,item.to_taxi OR roster.is_on_taxi
  FROM trades trade JOIN trade_items item ON item.trade_id=trade.id AND item.to_member_id=p_member_id
  JOIN roster_players roster ON roster.league_season_id=trade.league_season_id AND roster.player_id=item.player_id
  WHERE trade.id=p_trade_id
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
  SELECT m.user_id INTO v_user FROM trades t JOIN league_members m ON m.id=t.proposer_member_id WHERE t.id=p_trade_id;
  v_teams:=public.get_trade_roster_preview(p_trade_id,v_user);
  SELECT string_agg(reason->>'message',' ') INTO v_error FROM jsonb_array_elements(v_teams) team
    CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason
    WHERE p_only_member_id IS NULL OR team->>'memberId'=p_only_member_id::text;
  IF v_error IS NOT NULL THEN RAISE EXCEPTION '%',v_error USING ERRCODE='PT409',DETAIL=v_teams::text; END IF;
END;
$$;

-- Canonical SQL source for public.complete_accepted_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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

CREATE OR REPLACE FUNCTION public.get_trade_roster_preview(p_trade_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_league uuid;
BEGIN
  SELECT league_id INTO v_league FROM trades WHERE id=p_trade_id;
  RETURN public.preview_trade_legality(p_user_id,v_league,NULL,NULL,'{}',p_trade_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.hold_trade_for_legality_atomic(p_trade_id uuid,p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_trade trades%ROWTYPE; v_teams jsonb; v_reasons jsonb; v_message text;
BEGIN
  SELECT * INTO STRICT v_trade FROM trades WHERE id=p_trade_id AND status='accepted' FOR UPDATE;
  SELECT public.get_trade_roster_preview(p_trade_id,user_id) INTO v_teams FROM league_members WHERE id=v_trade.proposer_member_id;
  SELECT COALESCE(jsonb_agg(reason),'[]'),string_agg(reason->>'message',' ') INTO v_reasons,v_message
    FROM jsonb_array_elements(v_teams) team CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason;
  IF jsonb_array_length(v_reasons)=0 THEN
    v_message:=COALESCE(p_reason,'Review this trade before execution.');
    v_reasons:=jsonb_build_array(jsonb_build_object('rule','execution','message',v_message,'suggestedMoves','[]'::jsonb));
  END IF;
  UPDATE trades SET legality_issues=v_reasons,completion_failure_reason=v_message WHERE id=p_trade_id;
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT format('trade_attention:%s:%s:%s',p_trade_id,member_id,md5(v_reasons::text)),member_id,'trade_needs_attention','Trade needs attention',
    v_message,jsonb_build_object('tradeId',p_trade_id,'reasons',v_reasons),'trade'
    FROM trade_participants WHERE trade_id=p_trade_id ON CONFLICT(dedupe_key) DO NOTHING;
END;
$$;

-- Canonical SQL source for public.process_due_accepted_trades_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.process_due_accepted_trades_atomic(
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  participant_member_ids uuid[],
  status text,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 0), 200);
  v_trade record;
  v_trade_ids uuid[];
  v_asset record;
  v_error_code text;
  v_error_message text;
BEGIN
  -- A batch retains league rows after each completion. Take every selected
  -- team's and player's locks before the first completion takes those rows.
  SELECT COALESCE(array_agg(due.id), ARRAY[]::uuid[]) INTO v_trade_ids
  FROM (
    SELECT trade.id
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  ) AS due;

  FOR v_asset IN
    SELECT DISTINCT trade.league_id, member.member_id
      FROM public.trades AS trade
      CROSS JOIN LATERAL (
        SELECT trade.proposer_member_id AS member_id
        UNION SELECT trade.recipient_member_id
        UNION SELECT participant.member_id FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
      ) AS member
     WHERE trade.id = ANY(v_trade_ids)
     ORDER BY trade.league_id, member.member_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.member_id::text));
  END LOOP;

  FOR v_asset IN
    SELECT DISTINCT trade.league_id, item.player_id
      FROM public.trades AS trade
      JOIN public.trade_items AS item ON item.trade_id = trade.id
     WHERE trade.id = ANY(v_trade_ids) AND item.player_id IS NOT NULL
     ORDER BY trade.league_id, item.player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.player_id::text));
  END LOOP;

  FOR v_trade IN
    SELECT
      trade.id,
      trade.proposer_member_id,
      trade.recipient_member_id,
      ARRAY(
        SELECT participant.member_id
          FROM public.trade_participants AS participant
         WHERE participant.trade_id = trade.id
         ORDER BY participant.sort_order, participant.member_id
      ) AS participant_member_ids
    FROM public.trades AS trade
    WHERE trade.id = ANY(v_trade_ids)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        CASE
          WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
          ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
        END,
        CASE WHEN EXISTS(SELECT 1 FROM trades WHERE id=v_trade.id AND jsonb_array_length(legality_issues)>0) THEN 'deferred' ELSE 'completed' END::text,
        NULL::text,
        NULL::text;
    EXCEPTION
      WHEN SQLSTATE 'PT001' OR SQLSTATE 'PT409' THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        PERFORM public.hold_trade_for_legality_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'deferred'::text,
          v_error_code,
          v_error_message;
      WHEN SQLSTATE 'PT002' THEN
        -- Deferred, not failed: the trade stays accepted and settles once the game slate ends.
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'deferred'::text,
          v_error_code,
          v_error_message;
      WHEN serialization_failure OR deadlock_detected OR lock_not_available THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
    END;
  END LOOP;
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

CREATE OR REPLACE FUNCTION public.submit_trade_offer_atomic(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_action text, p_payload jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
  v_member_league uuid;
BEGIN
  BEGIN
    __request_context := private.request_begin('public.submit_trade_offer_atomic', jsonb_build_array(p_user_id, p_request_id, p_member_id, p_action, p_payload - 'estimateId'), p_request_id, NULL, p_user_id);
  EXCEPTION WHEN invalid_parameter_value THEN
    IF NOT EXISTS (SELECT 1 FROM league_members WHERE id=p_member_id AND user_id=p_user_id) THEN
      RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE='42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM private.request_receipts
      WHERE request_id=p_request_id AND actor IS DISTINCT FROM p_user_id
    ) OR EXISTS (
      SELECT 1 FROM private.trade_offer_requests
      WHERE user_id=p_user_id AND request_id=p_request_id AND member_id IS DISTINCT FROM p_member_id
    ) THEN
      RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
    END IF;
    RAISE;
  END;
  SELECT league_id INTO v_member_league FROM league_members
    WHERE id=p_member_id AND user_id=p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id AND member_id IS DISTINCT FROM p_member_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
  END IF;
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE
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
  v_plans jsonb; v_check_items jsonb; v_check_teams jsonb; v_check_error text; v_plan_entry record;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('propose','propose-multi','edit','edit-multi','counter','counter-multi')
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A request key, supported offer action, and offer payload are required.' USING ERRCODE='22023';
  END IF;
  v_multi := p_action LIKE '%-multi';
  v_notes := NULLIF(btrim(p_payload->>'notes'),'');
  v_expiration := (p_payload->>'expiresAt')::timestamptz;
  v_envelope := jsonb_build_object('version',1,'action',p_action,'memberId',p_member_id,
    'notes',v_notes,'expiresAt',v_expiration);
  IF p_payload ? 'rosterPlans' THEN v_envelope:=v_envelope||jsonb_build_object('rosterPlans',p_payload->'rosterPlans'); END IF;
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

  IF v_source IS NOT NULL THEN
    SELECT league_id,league_season_id,CASE WHEN p_action LIKE 'counter%' THEN proposer_member_id ELSE recipient_member_id END
      INTO v_league,v_season,v_recipient FROM trades WHERE id=v_source;
    IF NOT v_multi AND p_payload ? 'recipientMemberId'
      AND (p_payload->>'recipientMemberId')::uuid IS DISTINCT FROM v_recipient THEN
      RAISE EXCEPTION 'The replacement must keep the original counterparty.' USING ERRCODE='22023';
    END IF;
  END IF;
  v_plans:=COALESCE(p_payload->'rosterPlans','{}')||jsonb_build_object(p_member_id::text,COALESCE(p_payload->'rosterPlan','{}'));
  FOR v_plan_entry IN SELECT * FROM jsonb_each(v_plans) LOOP
    IF v_plan_entry.key<>p_member_id::text AND (jsonb_array_length(COALESCE(v_plan_entry.value->'dropPlayerIds','[]'))>0 OR jsonb_array_length(COALESCE(v_plan_entry.value->'rosterMoves','[]'))>0) THEN
      RAISE EXCEPTION 'Only a team manager can choose its drops and moves.' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF v_multi THEN v_check_items:=v_items;
  ELSE
    v_participants:=ARRAY[p_member_id,v_recipient];
    SELECT COALESCE(jsonb_agg(item),'[]') INTO v_check_items FROM (
      SELECT jsonb_build_object('playerId',id,'fromMemberId',p_member_id,'toMemberId',v_recipient) item FROM unnest(v_offer_players) id
      UNION ALL SELECT jsonb_build_object('playerId',id,'fromMemberId',v_recipient,'toMemberId',p_member_id) FROM unnest(v_request_players) id
      UNION ALL SELECT jsonb_build_object('fromMemberId',p_member_id,'toMemberId',v_recipient,'faabAmount',v_offer_faab)
      UNION ALL SELECT jsonb_build_object('fromMemberId',v_recipient,'toMemberId',p_member_id,'faabAmount',v_request_faab)
    ) items;
  END IF;
  v_check_teams:=private.check_trade_legality(v_league,v_season,v_participants,v_check_items,v_plans,v_source);
  SELECT string_agg(reason->>'message',' ') INTO v_check_error FROM jsonb_array_elements(v_check_teams) team
    CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason
    WHERE team->>'memberId'=p_member_id::text;
  IF v_check_error IS NOT NULL THEN RAISE EXCEPTION '%',v_check_error USING ERRCODE='PT409',DETAIL=v_check_teams::text; END IF;

  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload)
    VALUES(p_user_id,p_request_id,p_member_id,v_envelope) ON CONFLICT(user_id,request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  -- The separate statement sees a concurrent claim after its transaction commits.
  SELECT * INTO STRICT v_receipt FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id FOR UPDATE;
  IF v_receipt.member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
  END IF;
  IF v_receipt.request_payload IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'This request key already belongs to different trade terms.' USING ERRCODE='22023';
  END IF;
  IF v_receipt.completed THEN __request_result := v_receipt.result_trade_id; EXIT request_write; END IF;
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
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' AND v_result IS NOT NULL THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[],
      COALESCE(p_payload->'rosterPlan'->'rosterMoves','[]'::jsonb));
  END IF;
  IF v_result IS NOT NULL THEN
    FOR v_plan_entry IN SELECT * FROM jsonb_each(v_plans) WHERE key<>p_member_id::text LOOP
      UPDATE trade_items SET to_ir=COALESCE(v_plan_entry.value->'irPlayerIds','[]') ? player_id::text,
        to_taxi=COALESCE(v_plan_entry.value->'taxiPlayerIds','[]') ? player_id::text OR EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=v_season AND roster_players.player_id=trade_items.player_id AND is_on_taxi)
        WHERE trade_id=v_result AND to_member_id=v_plan_entry.key::uuid AND player_id IS NOT NULL;
    END LOOP;
    PERFORM private.validate_trade_rosters(v_result,p_member_id);
    PERFORM private.attach_trade_estimate(v_result,p_member_id,(p_payload->>'estimateId')::uuid);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  __request_result := v_result; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

REVOKE ALL ON FUNCTION private.check_trade_legality(uuid,uuid,uuid[],jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.check_trade_legality(uuid,uuid,uuid[],jsonb,jsonb,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.preview_trade_legality(uuid,uuid,uuid[],jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_trade_legality(uuid,uuid,uuid[],jsonb,jsonb,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.hold_trade_for_legality_atomic(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hold_trade_for_legality_atomic(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.withdraw_trade_atomic(
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
  __request_context := private.request_begin('public.withdraw_trade_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_trade trades%ROWTYPE;
  v_previous_flag text;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status AND NOT COALESCE((
    v_trade.status = 'accepted'::public.trade_status AND v_trade.veto_window_expires_at > now()
  ), false) THEN
    RAISE EXCEPTION 'Only pending trades or trades still in their review window can be cancelled.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.proposer_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade proposer can withdraw this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  v_previous_flag:=private.begin_trade_lifecycle_write();
  UPDATE public.trades
     SET status = 'withdrawn'::public.trade_status
   WHERE id = p_trade_id
     AND status = v_trade.status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade can no longer be cancelled.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);
  __request_result := jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
