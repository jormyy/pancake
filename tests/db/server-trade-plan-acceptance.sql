BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; players uuid[]; offer uuid; items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9522);
  UPDATE leagues SET roster_size=2,allow_inactive_trades=true WHERE id=f.league_id;
  players:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Plan',id::text,'PG',ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[(n+1)/2],players[n],'draft' FROM generate_series(1,6) n;
  items:=jsonb_build_array(
    jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[3],'playerId',players[1]),
    jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[1],'playerId',players[3]),
    jsonb_build_object('fromMemberId',f.member_ids[3],'toMemberId',f.member_ids[2],'playerId',players[5]),
    jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[3],'playerId',players[4]));
  offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose-multi',
    jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'participantMemberIds',f.member_ids,'items',items));
  PERFORM public.accept_trade_atomic(offer,f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT accepted_at IS NOT NULL FROM trade_participants WHERE trade_id=offer AND member_id=f.member_ids[2]),
    'early acceptor succeeds while another team still needs a drop');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',offer,f.member_ids[3]),
    'Rules team 3 must change its trade plan to meet the active roster limit.','final acceptance validates all teams');
  PERFORM public.set_trade_roster_plan_atomic(offer,f.member_ids[3],f.user_ids[3],'{}','{}',ARRAY[players[6]]);
  PERFORM public.accept_trade_atomic(offer,f.member_ids[3]);
  PERFORM pg_temp.check_rules((SELECT status='accepted' FROM trades WHERE id=offer),'final acceptance succeeds after final team plan');
END;
$$;
DO $$
DECLARE f record; players uuid[]; offer uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9523);
  UPDATE leagues SET roster_size=2,allow_inactive_trades=true WHERE id=f.league_id;
  players:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Accepted',id::text,'PG',ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN n<=2 THEN 1 ELSE 2 END],players[n],'draft' FROM generate_series(1,5) n;
  offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',
    jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
      'offerPlayerIds',ARRAY[players[1]],'requestPlayerIds',ARRAY[players[3],players[4]],'rosterPlan',jsonb_build_object('taxiPlayerIds','[]'::jsonb,'irPlayerIds','[]'::jsonb,'dropPlayerIds',ARRAY[players[2]])));
  PERFORM pg_temp.reject_rules(format('SELECT public.set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L)',
    offer,f.member_ids[1],f.user_ids[1],'{}','{}','{}'),
    'Rules team 1 must change its trade plan to meet the active roster limit.','accepted proposer cannot save an over-cap plan');
  PERFORM pg_temp.check_rules((SELECT drop_player_ids=ARRAY[players[2]] FROM trade_participants WHERE trade_id=offer AND member_id=f.member_ids[1]),
    'invalid plan edit preserves the accepted plan');
END;
$$;
DO $$
DECLARE f record; v_players uuid[]; offer uuid; kind text; expected text; prior_season uuid;
BEGIN
  FOREACH kind IN ARRAY ARRAY['ir','eligibility','tenure','promoted'] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(3,9534);
    UPDATE leagues SET allow_inactive_trades=true,taxi_slots=3,taxi_rule='rookies_or_64_games',taxi_max_seasons=1 WHERE id=f.league_id;
    v_players:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
      SELECT id,'Scoped',id::text,'PG',ARRAY['PG'],0,0,'Out' FROM unnest(v_players) id;
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      SELECT f.league_id,f.season_id,f.member_ids[n],v_players[n],'draft' FROM generate_series(1,3) n;
    offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose-multi',
      jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'participantMemberIds',f.member_ids,'items',jsonb_build_array(
        jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[3],'playerId',v_players[1]),
        jsonb_build_object('fromMemberId',f.member_ids[3],'toMemberId',f.member_ids[2],'playerId',v_players[3]),
        jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[1],'playerId',v_players[2]))));
    IF kind='ir' THEN
      UPDATE trade_items SET to_ir=true WHERE trade_id=offer AND player_id=v_players[1];
      UPDATE players SET injury_status=NULL WHERE id=v_players[1];
      expected:='Incoming IR players must be Out or IR-designated and cannot also enter taxi.';
    ELSE
      UPDATE trade_items SET to_taxi=true WHERE trade_id=offer AND player_id=v_players[1];
      IF kind='eligibility' THEN
        UPDATE players SET years_exp=5,career_regular_season_games=65 WHERE id=v_players[1];
        expected:='Incoming taxi players must be rookies or have fewer than 65 career regular-season games.';
      ELSIF kind='tenure' THEN
        prior_season:=gen_random_uuid();
        INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(prior_season,f.league_id,9533,false);
        INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type)
          VALUES(f.league_id,prior_season,f.member_ids[1],v_players[1],'taxi_designate');
        expected:='Incoming taxi player has reached the taxi tenure limit.';
      ELSE
        INSERT INTO league_member_taxi_exits(league_id,member_id,player_id) VALUES(f.league_id,f.member_ids[3],v_players[1]);
        expected:='A promoted player cannot return to this team taxi squad.';
      END IF;
    END IF;
    PERFORM public.accept_trade_atomic(p_trade_id=>offer,p_accepting_member_id=>f.member_ids[2]);
    PERFORM pg_temp.check_rules((SELECT accepted_at IS NOT NULL FROM trade_participants WHERE trade_id=offer AND member_id=f.member_ids[2]),
      kind||' other recipient does not block early acceptance');
    PERFORM pg_temp.reject_rules(format('SELECT private.validate_trade_rosters(%L)',offer),expected,kind||' full validation checks all recipients');
    PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',offer,f.member_ids[3]),expected,kind||' invalid recipient still cannot accept');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
