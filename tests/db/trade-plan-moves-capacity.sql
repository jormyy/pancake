BEGIN;
\ir rules-support.sql
UPDATE public.waiver_claims SET process_date=current_date+365000 WHERE status='pending';
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  trade uuid; claim uuid; move jsonb; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9583);
  UPDATE leagues SET roster_size=2,ir_slots=1,allow_inactive_trades=true,trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  FOR i IN 1..5 LOOP
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,injury_status)
      VALUES(p[i],'Plan','Player '||i,'PG',ARRAY['PG'],3,CASE WHEN i=2 THEN 'Out' END);
  END LOOP;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN n<=2 THEN 1 ELSE 2 END],p[n],'draft' FROM generate_series(1,4) n;
  trade:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[2],f.member_ids[1],ARRAY[p[3],p[4]],ARRAY[p[1]],'{}','{}');
  PERFORM pg_temp.reject_rules(format('SELECT get_trade_roster_preview(%L,%L)',trade,gen_random_uuid()),'%cannot view%','preview rejects a non-member');
  PERFORM pg_temp.check_rules((public.get_trade_roster_preview(trade,f.user_ids[1])->1->>'error') IS NOT NULL,'preview reports recipient overflow before planning');
  PERFORM pg_temp.reject_rules(format('SELECT set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L,%L::jsonb)',trade,f.member_ids[1],f.user_ids[2],'{}','{}','{}','[]'),'%Only the receiving manager%','another manager cannot set the plan');
  PERFORM pg_temp.reject_rules(format('SELECT set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L,%L::jsonb)',trade,f.member_ids[1],f.user_ids[1],'{}','{}','{}',jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','taxi'))),
    '%Only incoming players%', 'a retained player cannot be saved onto Taxi');
  move:=jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','ir'));
  PERFORM pg_temp.reject_rules(format('SELECT set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L,%L::jsonb)',trade,f.member_ids[1],f.user_ids[1],'{}','{}','{}',move||move),'%unique%','duplicate moves cannot reserve the same player twice');
  PERFORM public.set_trade_roster_plan_atomic(trade,f.member_ids[1],f.user_ids[1],'{}','{}','{}',move);
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE player_id=p[2]),'a saved move does not change the roster');
  PERFORM public.accept_trade_atomic(trade,f.member_ids[1]);
  PERFORM set_config('app.trade_lifecycle_server_write','on',true);
  PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_ir=true WHERE player_id=%L',p[2]),'%Locked by trade%','accepted move asset cannot move early even with a forged setting');
  PERFORM set_config('app.trade_lifecycle_server_write','',true);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  UPDATE players SET injury_status=NULL WHERE id=p[2];
  PERFORM public.complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.check_rules((SELECT status='accepted' AND legality_issues @> '[{"rule":"ir_eligibility"}]' FROM trades WHERE id=trade),'recovered retained player holds settlement');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE player_id=p[3]),'invalid plan moves no assets');
  UPDATE players SET injury_status='Out' WHERE id=p[2];
  PERFORM public.complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE player_id=p[2]),'settlement applies retained IR move');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM roster_players WHERE member_id=f.member_ids[1] AND NOT is_on_ir AND NOT is_on_taxi),'settlement fits regular capacity');
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=trade),'valid move plan completes');
END;
$$;
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; trade uuid; other_trade uuid; claim uuid; pick uuid:=gen_random_uuid(); other_pick uuid:=gen_random_uuid(); i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9584);
  UPDATE leagues SET roster_size=2,allow_inactive_trades=true,trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  UPDATE league_members SET role='co_commissioner' WHERE id=f.member_ids[3];
  FOR i IN 1..4 LOOP
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp)
      VALUES(p[i],'Capacity','Player '||i,'PG',ARRAY['PG'],3);
  END LOOP;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p[1],'draft'),(f.league_id,f.season_id,f.member_ids[2],p[2],'draft'),(f.league_id,f.season_id,f.member_ids[3],p[4],'draft');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(pick,f.league_id,9585,1,f.member_ids[2],f.member_ids[2]),(other_pick,f.league_id,9585,2,f.member_ids[2],f.member_ids[2]);
  trade:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[p[1]],'{}','{}',ARRAY[pick]);
  PERFORM public.accept_trade_atomic(trade,f.member_ids[2]);
  other_trade:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[3],f.member_ids[2],ARRAY[p[4]],'{}','{}',ARRAY[other_pick]);
  PERFORM pg_temp.reject_rules(format('SELECT accept_trade_atomic(%L,%L)',other_trade,f.member_ids[2]),'%accepted trades reserve%','two accepted trades cannot consume the same free slot');
  PERFORM public.withdraw_trade_atomic(other_trade,f.member_ids[3],f.user_ids[3]);
  claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[2],p[3],NULL,f.user_ids[2],0,1);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules((SELECT status='failed_roster' AND failure_reason LIKE '%reserve roster capacity%' FROM waiver_claims WHERE id=claim),'waiver cannot spend accepted capacity');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE player_id=p[3]),'failed capacity award has no acquisition');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM weekly_add_counts WHERE member_id=f.member_ids[2] AND add_count>0),'failed capacity award consumes no add');
  PERFORM public.veto_trade_atomic(trade,f.member_ids[3]);
  claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[2],p[3],NULL,f.user_ids[2],0,1);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM waiver_claims WHERE id=claim),'veto releases reserved capacity');
END;
$$;
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; trade uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9586);
  UPDATE leagues SET roster_size=2,taxi_slots=1,allow_inactive_trades=true,trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    SELECT id,'Taxi','Plan player','PG',ARRAY['PG'],0,0 FROM unnest(p) id;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p[1],'draft'),(f.league_id,f.season_id,f.member_ids[2],p[3],'draft');
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],p[2],'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p[2],'draft',true);
  trade:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[2],f.member_ids[1],ARRAY[p[3]],ARRAY[p[1]],'{}','{}');
  UPDATE players SET years_exp=4,career_regular_season_games=65 WHERE id=p[2];
  PERFORM public.set_trade_roster_plan_atomic(trade,f.member_ids[1],f.user_ids[1],'{}','{}','{}',jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','active')));
  PERFORM public.accept_trade_atomic(trade,f.member_ids[1]);
  PERFORM pg_temp.check_rules((SELECT is_on_taxi FROM roster_players WHERE player_id=p[2]),'planned promotion remains on taxi before settlement');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  PERFORM public.complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.check_rules((SELECT NOT is_on_taxi AND NOT is_on_ir FROM roster_players WHERE player_id=p[2]),'settlement promotes a retained ineligible taxi player');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=f.league_id AND member_id=f.member_ids[1] AND player_id=p[2]),'planned promotion records the permanent taxi exit');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
