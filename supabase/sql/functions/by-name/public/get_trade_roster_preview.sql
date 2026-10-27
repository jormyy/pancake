CREATE OR REPLACE FUNCTION public.get_trade_roster_preview(p_trade_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_trade trades%ROWTYPE; v_league leagues%ROWTYPE; v_team record; v_error text; v_teams jsonb:='[]'; v_roster jsonb; v_drops jsonb; v_unavailable jsonb; v_destinations jsonb;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM league_members WHERE league_id=v_trade.league_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'You cannot view this trade roster plan.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_league FROM leagues WHERE id=v_trade.league_id;
  FOR v_team IN SELECT participant.*,member.team_name FROM trade_participants participant
    JOIN league_members member ON member.id=participant.member_id WHERE trade_id=p_trade_id ORDER BY sort_order,member_id
  LOOP
    v_error:=NULL;
    BEGIN
      PERFORM private.validate_trade_rosters(p_trade_id,v_team.member_id);
      PERFORM private.assert_accepted_trade_capacity(v_trade.league_id,v_trade.league_season_id,v_team.member_id,p_trade_id);
    EXCEPTION WHEN SQLSTATE 'PT001' THEN v_error:=SQLERRM;
    END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',player.id,'name',player.display_name,
      'location',CASE WHEN result.on_taxi THEN 'taxi' WHEN result.on_ir THEN 'ir' ELSE 'active' END) ORDER BY player.display_name),'[]') INTO v_roster
    FROM private.trade_resulting_roster(p_trade_id,v_team.member_id) result JOIN players player ON player.id=result.player_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',player.id,'name',player.display_name) ORDER BY player.display_name),'[]') INTO v_drops
      FROM players player WHERE player.id=ANY(v_team.drop_player_ids);
    SELECT COALESCE(jsonb_object_agg(player_id::text,reason) FILTER(WHERE reason IS NOT NULL),'{}') INTO v_unavailable
    FROM (SELECT roster.player_id,CASE
      WHEN private.is_reserved_trade_asset(v_trade.league_id,v_trade.league_season_id,v_team.member_id,roster.player_id,NULL,p_trade_id) THEN 'Reserved by another trade.'
      WHEN EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id AND member_id=v_team.member_id
        AND status='pending' AND drop_player_id=roster.player_id) THEN 'Reserved as a pending waiver drop.'
      END AS reason FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id AND roster.member_id=v_team.member_id) unavailable;
    SELECT COALESCE(jsonb_object_agg(item.player_id::text,jsonb_strip_nulls(jsonb_build_object(
      'ir',CASE WHEN v_league.ir_slots=0 THEN 'This league has no IR slots.' WHEN NOT private.is_ir_designation(player.injury_status) THEN 'IR requires an Out or IR designation.' END,
      'taxi',CASE WHEN v_league.taxi_slots=0 THEN 'This league has no taxi slots.'
        WHEN EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=v_trade.league_id AND member_id=v_team.member_id AND player_id=item.player_id) THEN 'This player cannot return to this team taxi squad.'
        WHEN NOT private.taxi_player_eligible(v_trade.league_id,item.player_id) THEN 'Taxi requires an eligible rookie or fewer than 65 known career games.'
        WHEN v_league.taxi_max_seasons IS NOT NULL AND (SELECT season_year FROM league_seasons WHERE id=v_trade.league_season_id)-private.taxi_start_year(v_trade.league_id,item.player_id,(SELECT season_year FROM league_seasons WHERE id=v_trade.league_season_id))>=v_league.taxi_max_seasons THEN 'This player has reached the taxi tenure limit.' END
    ))),'{}') INTO v_destinations FROM trade_items item JOIN players player ON player.id=item.player_id
      WHERE item.trade_id=p_trade_id AND item.to_member_id=v_team.member_id;
    v_teams:=v_teams||jsonb_build_array(jsonb_build_object('memberId',v_team.member_id,'teamName',v_team.team_name,
      'unavailableMoves',v_unavailable,'unavailableDestinations',v_destinations,'roster',v_roster,'drops',v_drops,'moves',v_team.roster_moves,'error',v_error,
      'plan',jsonb_build_object('rosterMoves',v_team.roster_moves,'dropPlayerIds',to_jsonb(v_team.drop_player_ids),
        'taxiPlayerIds',(SELECT COALESCE(jsonb_agg(player_id),'[]') FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=v_team.member_id AND to_taxi),
        'irPlayerIds',(SELECT COALESCE(jsonb_agg(player_id),'[]') FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=v_team.member_id AND to_ir)),
      'limits',jsonb_build_object('active',v_league.roster_size,'ir',v_league.ir_slots,'taxi',v_league.taxi_slots)));
  END LOOP;
  RETURN v_teams;
END;
$$;
