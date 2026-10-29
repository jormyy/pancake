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
