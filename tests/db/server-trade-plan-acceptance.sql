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
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
