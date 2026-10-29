BEGIN;
\ir rules-support.sql
CREATE FUNCTION pg_temp.fail_trade_transfer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.member_id<>NEW.member_id AND OLD.player_id::text=current_setting('pancake.test_fail_transfer_player',true) THEN
    RAISE EXCEPTION 'Trade execution rollback control.' USING ERRCODE='PT002';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_trade_transfer_failure BEFORE UPDATE OF member_id ON roster_players
  FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_trade_transfer();
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; t uuid; teams jsonb; plans jsonb; items jsonb; past_season uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9588);
  UPDATE leagues SET roster_size=1,ir_slots=1,taxi_slots=1,allow_inactive_trades=true,trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
    SELECT id,'Legality','Player '||n,'PG',ARRAY['PG'],0,0,'Out' FROM unnest(p) WITH ORDINALITY AS ids(id,n);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p[1],'draft',true),
      (f.league_id,f.season_id,f.member_ids[1],p[2],'draft',false),
      (f.league_id,f.season_id,f.member_ids[2],p[3],'draft',false);
  t:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[p[1]],ARRAY[p[3]],'{}','{}');
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  UPDATE leagues SET allow_inactive_trades=false WHERE id=f.league_id;
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"ir_trade_eligibility"}]','inactive trade rule names IR');
  UPDATE leagues SET allow_inactive_trades=true WHERE id=f.league_id;
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"active_slots"}]','IR swap reports the Regular slot rule');
  PERFORM pg_temp.check_rules(teams->0->>'error' LIKE '%from IR does not free a Regular slot%','IR swap explains the missing Regular slot');
  PERFORM pg_temp.check_rules(jsonb_array_length(teams->0->'reasons'->0->'suggestedMoves')>0,'IR swap names concrete fixes');
  plans:=jsonb_build_object(f.member_ids[1]::text,jsonb_build_object('irPlayerIds',ARRAY[p[3]]));
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,NULL,NULL,plans,t);
  PERFORM pg_temp.check_rules((teams->0->>'legal')::boolean,'incoming IR placement fixes the sender');
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,NULL,NULL,
    jsonb_build_object(f.member_ids[1]::text,jsonb_build_object('irPlayerIds',ARRAY[p[3]],'taxiPlayerIds',ARRAY[p[3]])),t);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"destination_slot"}]','one incoming player cannot use two destinations');
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,NULL,NULL,
    jsonb_build_object(f.member_ids[1]::text,jsonb_build_object('rosterMoves',jsonb_build_array(jsonb_build_object('playerId',p[4],'destination','ir')))),t);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"planned_move"}]','missing retained player is structured');

  PERFORM public.set_trade_roster_plan_atomic(t,f.member_ids[1],f.user_ids[1],'{}',ARRAY[p[3]],'{}');
  UPDATE leagues SET roster_size=0 WHERE id=f.league_id;
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"active_slots"}]','Regular capacity is structured');
  UPDATE leagues SET roster_size=1,ir_slots=0,taxi_slots=0 WHERE id=f.league_id;
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"roster_size"},{"rule":"ir_limit"},{"rule":"ir_eligibility"}]','total and IR limits are structured');
  UPDATE leagues SET ir_slots=1,taxi_slots=1 WHERE id=f.league_id;
  UPDATE players SET injury_status=NULL WHERE id=p[3];
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"ir_eligibility"}]','IR designation is structured');
  PERFORM public.set_trade_roster_plan_atomic(t,f.member_ids[1],f.user_ids[1],ARRAY[p[3]],'{}','{}');
  UPDATE players SET years_exp=3,career_regular_season_games=65 WHERE id=p[3];
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"taxi_eligibility"}]','taxi career games are structured');
  UPDATE players SET career_regular_season_games=NULL WHERE id=p[3];
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"taxi_eligibility"}]','unknown career games block taxi');
  UPDATE players SET years_exp=0,career_regular_season_games=0 WHERE id=p[3];
  UPDATE leagues SET taxi_max_seasons=1 WHERE id=f.league_id;
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(past_season,f.league_id,9587,false);
  INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,acquired_to_taxi)
    VALUES(f.league_id,past_season,f.member_ids[2],p[3],'taxi_designate',true);
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->>'error' LIKE '%taxi tenure limit%','taxi tenure has its own explanation');
  UPDATE leagues SET taxi_max_seasons=NULL WHERE id=f.league_id;
  DELETE FROM roster_transactions WHERE league_season_id=past_season;
  DELETE FROM league_seasons WHERE id=past_season;

  UPDATE leagues SET taxi_slots=0 WHERE id=f.league_id;
  teams:=public.get_trade_roster_preview(t,f.user_ids[1]);
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"taxi_limit"}]','taxi capacity is structured');
  UPDATE leagues SET taxi_slots=1,waiver_mode='faab' WHERE id=f.league_id;
  items:=jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'faabAmount',100000));
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,f.member_ids,items,'{}');
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"budget"}]','budget is structured');
  UPDATE players SET years_exp=3,career_regular_season_games=65 WHERE id=p[3];
  PERFORM pg_temp.reject_rules(format('SELECT accept_trade_with_plan_atomic(%L,%L,%L,%L,%L,%L)',t,f.member_ids[2],f.user_ids[2],'{}','{}','{}'),'%TAXI%','invalid sender plan blocks acceptance');
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=t),'failed acceptance saves no status change');
  UPDATE players SET years_exp=0,career_regular_season_games=0,injury_status='Out' WHERE id=p[3];
  PERFORM public.accept_trade_atomic(t,f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT status='accepted' FROM trades WHERE id=t),'acceptance waits for review');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE player_id=p[3]),'acceptance moves no player');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=t;
  UPDATE players SET years_exp=3,career_regular_season_games=65 WHERE id=p[3];
  PERFORM public.complete_accepted_trade_atomic(t);
  PERFORM pg_temp.check_rules((SELECT status='accepted' AND legality_issues @> '[{"rule":"taxi_eligibility"}]' FROM trades WHERE id=t),'changed eligibility holds the trade');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM notification_outbox WHERE data->>'tradeId'=t::text AND event_type='trade_needs_attention'),'both managers receive attention notices');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE player_id=p[3]),'held trade moves no player');
  UPDATE players SET years_exp=0,career_regular_season_games=0 WHERE id=p[3];
  PERFORM public.complete_accepted_trade_atomic(t);
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=t),'repaired eligibility permits execution');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] AND is_on_taxi FROM roster_players WHERE player_id=p[3]),'execution applies incoming taxi destination');
END;
$$;
DO $$
DECLARE f record; teams jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(12,9591);
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,f.member_ids,'[]','{}');
  PERFORM pg_temp.check_rules(jsonb_array_length(teams)=12,'all twelve trade teams receive a verdict');
END;
$$;
SELECT count(*) AS passed_before_taxi_execution FROM rules_checks;
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; t uuid; request uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9590);
  UPDATE leagues SET roster_size=1,ir_slots=1,taxi_slots=1,allow_inactive_trades=true,trade_veto_mode='disabled' WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
    SELECT id,'Terms','Player '||n,'PG',ARRAY['PG'],0,0,'Out' FROM unnest(p) WITH ORDINALITY AS ids(id,n);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p[1],'draft',true),
      (f.league_id,f.season_id,f.member_ids[1],p[2],'draft',false),(f.league_id,f.season_id,f.member_ids[2],p[3],'draft',false),
      (f.league_id,f.season_id,f.member_ids[1],p[4],'draft',false);
  t:=public.submit_trade_offer_atomic(f.user_ids[1],request,f.member_ids[1],'propose',jsonb_build_object(
    'leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
    'offerPlayerIds',ARRAY[p[1]],'requestPlayerIds',ARRAY[p[3]],
    'rosterPlan',jsonb_build_object('taxiPlayerIds','[]'::jsonb,'irPlayerIds','[]'::jsonb,'dropPlayerIds',ARRAY[p[4]],
      'rosterMoves',jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','ir')))));
  PERFORM pg_temp.check_rules((SELECT roster_moves @> jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','ir')) FROM trade_participants WHERE trade_id=t AND member_id=f.member_ids[1]),'submission saves sender IR move');
  PERFORM pg_temp.check_rules((SELECT NOT is_on_ir FROM roster_players WHERE player_id=p[2]),'submission does not apply sender move');
  PERFORM public.accept_trade_with_plan_atomic(t,f.member_ids[2],f.user_ids[2],'{}',ARRAY[p[1]],'{}');
  PERFORM pg_temp.check_rules((SELECT status='accepted' FROM trades WHERE id=t),'zero-window acceptance still does not execute');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] FROM roster_players WHERE player_id=p[1]),'zero-window acceptance leaves assets untouched');
  PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_ir=true WHERE player_id=%L',p[2]),'%Locked by trade %','ordinary roster write stays blocked');
  PERFORM set_config('pancake.applied_trade_id',t::text,true);
  PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_ir=true WHERE player_id=%L',p[2]),'%Locked by trade %','a forged trade setting does not authorize a roster write');
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],p[2],'trade',t);
  PERFORM set_config('pancake.applied_trade_id','',true);
  PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_taxi=true WHERE player_id=%L',p[2]),'%Locked by trade %','a row proof without executor context stays blocked');
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],p[4],'trade',t);
  PERFORM set_config('pancake.applied_trade_id',t::text,true);
  PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_ir=true WHERE player_id=%L',p[4]),'%Locked by trade %','executor context cannot apply a move absent from saved terms');
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],p[2],'trade',gen_random_uuid());
  PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_taxi=true WHERE player_id=%L',p[2]),'%Locked by trade %','executor context must match the row proof trade');
  PERFORM set_config('pancake.applied_trade_id','',true);
  PERFORM pg_temp.check_rules(NOT has_schema_privilege('authenticated','private','USAGE')
    OR NOT has_function_privilege('authenticated','private.authorize_taxi_acquisition(uuid,uuid,uuid,uuid,text,uuid)','EXECUTE'),
    'ordinary users cannot create private execution proofs');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','private.taxi_acquisition_context','INSERT,UPDATE,DELETE'),
    'ordinary users cannot forge execution proof rows');
  PERFORM set_config('pancake.test_fail_transfer_player',p[1]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT complete_accepted_trade_atomic(%L)',t),'%rollback control%','a late execution failure rolls back the trade');
  PERFORM pg_temp.check_rules((SELECT NOT is_on_ir FROM roster_players WHERE player_id=p[2]),'late failure rolls back the retained IR move');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE player_id=p[4]),'late failure rolls back the planned drop');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] FROM roster_players WHERE player_id=p[1]),'late failure rolls back ownership');
  PERFORM pg_temp.check_rules(COALESCE(current_setting('pancake.applied_trade_id',true),'')='','failed execution does not leak its context');
  PERFORM set_config('pancake.test_fail_transfer_player','',true);
  PERFORM public.complete_accepted_trade_atomic(t);
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE player_id=p[2]),'execution applies retained IR move');
  PERFORM pg_temp.check_rules((SELECT is_on_ir AND member_id=f.member_ids[2] FROM roster_players WHERE player_id=p[1]),'execution applies acceptor incoming IR');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE player_id=p[4]),'execution applies the saved drop with both roster plans');
  PERFORM pg_temp.check_rules(COALESCE(current_setting('pancake.applied_trade_id',true),'')='','successful execution restores its context');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
