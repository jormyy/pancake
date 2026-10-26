BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
CREATE TEMP TABLE plan_checks(label text PRIMARY KEY);
CREATE TEMP SEQUENCE plan_transfer_attempts;
CREATE FUNCTION pg_temp.check_plan(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO plan_checks VALUES(label);
END;
$$;
CREATE FUNCTION pg_temp.fail_plan(command text,expected text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_plan(message ~ expected,label||COALESCE(' ['||message||']',' [unexpected success]'));
END;
$$;
CREATE FUNCTION pg_temp.reject_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    PERFORM nextval('pg_temp.plan_transfer_attempts');
    IF NEW.player_id::text=current_setting('dynasty.fail_player',true) THEN RAISE EXCEPTION 'forced settlement failure' USING ERRCODE='PT001'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE
  users uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  members uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_players uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); trade uuid; other_trade uuid;
  fail_player uuid;
  previous_season uuid:=gen_random_uuid();
  v_picks uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  claim uuid; wire uuid:=gen_random_uuid(); i int; before_rosters jsonb; after_rosters jsonb; v_terminal text;
BEGIN
  FOR i IN 1..3 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots,taxi_rule,taxi_max_seasons,allow_inactive_trades,trade_veto_mode,trade_veto_window_hours)
  VALUES(league,'Trade plan fixture',league::text,users[1],'active',2,1,1,'rookies_or_64_games',2,true,'commissioner',24);
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8300,true);
  FOR i IN 1..3 LOOP
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' WHEN i=3 THEN 'co_commissioner' ELSE 'manager' END::league_member_role,'Plan team '||i);
    INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority) VALUES(league,season,members[i],i);
  END LOOP;
  FOR i IN 1..6 LOOP
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
    VALUES(v_players[i],'Plan','Player '||i,'PG',ARRAY['PG'],CASE WHEN i=1 THEN 1 ELSE 3 END,CASE WHEN i=1 THEN 64 ELSE 100 END,CASE WHEN i=2 THEN 'Out' ELSE NULL END);
  END LOOP;
  UPDATE league_seasons SET is_current=false WHERE id=season;
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(previous_season,league,8299,true);
  PERFORM private.authorize_taxi_acquisition(league,previous_season,members[1],v_players[1],'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
    VALUES(league,previous_season,members[1],v_players[1],true,'draft');
  UPDATE league_seasons SET is_current=false WHERE id=previous_season;
  UPDATE league_seasons SET is_current=true WHERE id=season;
  PERFORM private.authorize_taxi_acquisition(league,season,members[1],v_players[1],'carry_over',previous_season);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
  VALUES(league,season,members[1],v_players[1],true,'draft');
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via)
  VALUES(league,season,members[2],v_players[2],true,'draft');
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(league,season,members[1],v_players[3],'draft'),(league,season,members[1],v_players[4],'draft'),(league,season,members[2],v_players[5],'draft');
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO before_rosters FROM roster_players roster WHERE league_season_id=season;
  trade:=submit_trade_offer_atomic(users[1],gen_random_uuid(),members[1],'propose',jsonb_build_object(
    'leagueId',league,'leagueSeasonId',season,'recipientMemberId',members[2],
    'offerPlayerIds',ARRAY[v_players[1]],'requestPlayerIds',ARRAY[v_players[2]],
    'rosterPlan',jsonb_build_object('taxiPlayerIds','[]'::jsonb,'irPlayerIds',ARRAY[v_players[2]],'dropPlayerIds',ARRAY[v_players[4]])));
  PERFORM pg_temp.check_plan((SELECT v_players[4]=ANY(drop_player_ids) FROM trade_participants WHERE trade_id=trade AND member_id=members[1]),'proposal stores proposer planned drop');
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO after_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.check_plan(before_rosters=after_rosters,'proposal performs no drop placement or tenure change');
  PERFORM pg_temp.check_plan((SELECT to_taxi FROM trade_items WHERE trade_id=trade AND player_id=v_players[1]),'taxi asset automatically retains taxi destination');
  PERFORM pg_temp.fail_plan(format('SELECT propose_trade_atomic(%L,%L,%L,%L,%L,%L,ARRAY[]::uuid[],ARRAY[]::uuid[])',league,season,members[1],members[2],ARRAY[v_players[4]]::text,ARRAY[v_players[2]]::text),'reserved|planned drop','pending planned drop cannot enter another trade');
  INSERT INTO waiver_wire_log(id,league_id,league_season_id,player_id,dropped_by_member_id,clears_at)
  VALUES(wire,league,season,v_players[6],members[3],now()+interval '48 hours');
  PERFORM pg_temp.fail_plan(format('SELECT create_waiver_claim_atomic(%L,%L,%L,%L,%L)',league,members[1],v_players[6],v_players[4],users[1]),'reserved|planned drop','trade planned drop blocks waiver drop');
  other_trade:=propose_trade_atomic(league,season,members[1],members[2],ARRAY[v_players[3]],ARRAY[v_players[2]],'{}','{}');
  PERFORM pg_temp.fail_plan(format('SELECT set_trade_roster_plan_atomic(%L,%L,%L,ARRAY[]::uuid[],%L,%L)',trade,members[1],users[1],ARRAY[v_players[2]]::text,ARRAY[v_players[3]]::text),'another trade|reserved','pending trade asset blocks planned drop');
  PERFORM withdraw_trade_atomic(other_trade,members[1],users[1]);
  claim:=create_waiver_claim_atomic(league,members[1],v_players[6],v_players[3],users[1]);
  PERFORM pg_temp.fail_plan(format('SELECT set_trade_roster_plan_atomic(%L,%L,%L,ARRAY[]::uuid[],%L,%L)',trade,members[1],users[1],ARRAY[v_players[2]]::text,ARRAY[v_players[3]]::text),'waiver|reserved','waiver drop blocks trade planned drop');
  PERFORM cancel_waiver_claim_atomic(claim,members[1],users[1]);
  UPDATE leagues SET roster_size=1,ir_slots=0,taxi_slots=0 WHERE id=league;
  PERFORM pg_temp.fail_plan(format('SELECT accept_trade_atomic(%L,%L)',trade,members[2]),'total roster limit','acceptance rejects total overflow');
  UPDATE leagues SET taxi_slots=1 WHERE id=league;
  PERFORM pg_temp.fail_plan(format('SELECT accept_trade_atomic(%L,%L)',trade,members[2]),'IR limit','acceptance rejects IR overflow');
  UPDATE leagues SET ir_slots=1,taxi_slots=0 WHERE id=league;
  PERFORM pg_temp.fail_plan(format('SELECT accept_trade_atomic(%L,%L)',trade,members[2]),'taxi limit','acceptance rejects taxi overflow');
  UPDATE leagues SET taxi_slots=1 WHERE id=league;
  UPDATE trade_items SET to_ir=false WHERE trade_id=trade AND to_member_id=members[1] AND player_id=v_players[2];
  PERFORM pg_temp.fail_plan(format('SELECT accept_trade_atomic(%L,%L)',trade,members[2]),'active roster limit','acceptance rejects legacy active overflow');
  PERFORM set_trade_roster_plan_atomic(trade,members[1],users[1],'{}',ARRAY[v_players[2]],ARRAY[v_players[4]]);
  PERFORM accept_trade_with_plan_atomic(trade,members[2],users[2],ARRAY[v_players[1]],'{}','{}');
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO after_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.check_plan(before_rosters=after_rosters AND (SELECT trades.status='accepted' FROM trades WHERE id=trade),'acceptance reserves plan without applying it');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  UPDATE leagues SET ir_slots=0,taxi_slots=0 WHERE id=league;
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'total roster limit','changed total limit refuses settlement');
  UPDATE leagues SET taxi_slots=1 WHERE id=league;
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'IR limit','changed IR limit refuses settlement');
  UPDATE leagues SET ir_slots=1,taxi_slots=0 WHERE id=league;
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'taxi limit','changed taxi limit refuses settlement');
  UPDATE leagues SET taxi_slots=1 WHERE id=league;
  UPDATE league_seasons SET season_year=8301 WHERE id=season;
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'tenure limit','taxi tenure cap revalidated at settlement');
  UPDATE league_seasons SET season_year=8300 WHERE id=season;
  UPDATE public.players SET career_regular_season_games=65 WHERE id=v_players[1];
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'fewer than 65','taxi games crossing65 refuses settlement');
  UPDATE public.players SET career_regular_season_games=64 WHERE id=v_players[1];
  UPDATE public.players SET injury_status=NULL WHERE id=v_players[2];
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'IR players must','injury change refuses settlement');
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO after_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.check_plan(before_rosters=after_rosters,'failed injury check leaves all assets drops placements and tenure intact');
  UPDATE public.players SET injury_status='Out' WHERE id=v_players[2];
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(league,season,members[2],v_players[6],'draft');
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'active roster limit','waiver pickup making receiver full refuses settlement');
  DELETE FROM roster_players WHERE league_season_id=season AND player_id=v_players[6];
  SELECT player_id INTO fail_player FROM trade_items WHERE trade_id=trade AND player_id IS NOT NULL ORDER BY created_at,id OFFSET 1 LIMIT 1;
  PERFORM set_config('dynasty.fail_player',fail_player::text,true);
  EXECUTE 'CREATE TRIGGER force_trade_failure BEFORE UPDATE ON roster_players FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_settlement()';
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'forced settlement failure','forced failure after drop rolls settlement back');
  EXECUTE 'DROP TRIGGER force_trade_failure ON roster_players';
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO after_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.check_plan(before_rosters=after_rosters AND (SELECT last_value=2 FROM pg_temp.plan_transfer_attempts) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log WHERE league_season_id=season AND player_id=v_players[4]),'mid settlement failure rolls back drops and waiver entries');
  UPDATE leagues SET roster_size=2 WHERE id=league;
  other_trade:=propose_trade_atomic(league,season,members[1],members[2],ARRAY[v_players[3]],ARRAY[v_players[2]],'{}','{}');
  claim:=create_waiver_claim_atomic(league,members[1],v_players[6],v_players[3],users[1]);
  UPDATE leagues SET roster_size=1 WHERE id=league;
  PERFORM complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.check_plan((SELECT member_id=members[2] AND is_on_taxi AND taxi_start_season_year=8299 FROM roster_players WHERE league_season_id=season AND player_id=v_players[1]),'completion transfers taxi with unchanged tenure');
  PERFORM pg_temp.check_plan((SELECT member_id=members[1] AND is_on_ir FROM roster_players WHERE league_season_id=season AND player_id=v_players[2]),'IR asset trades straight into receiver IR');
  PERFORM pg_temp.check_plan(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=season AND player_id=v_players[4]) AND EXISTS(SELECT 1 FROM waiver_wire_log WHERE league_season_id=season AND player_id=v_players[4] AND clears_at >= placed_on_waivers_at+interval '48 hours' AND clears_at < placed_on_waivers_at+interval '73 hours' AND (clears_at AT TIME ZONE 'America/New_York')::time = '03:00'::time),'planned drop enters waivers at the first eligible 3 AM ET run');
  PERFORM pg_temp.check_plan((SELECT trades.status='expired' AND completion_failure_reason IS NOT NULL FROM trades WHERE id=other_trade),'overlapping pending trade invalidated with explicit reason');
  PERFORM pg_temp.check_plan((SELECT status='pending' FROM waiver_claims WHERE id=claim),'unaffected waiver claim survives unrelated trade');
  PERFORM cancel_waiver_claim_atomic(claim,members[1],users[1]);
  FOR v_terminal IN SELECT unnest(ARRAY['rejected','withdrawn','expired','vetoed']) LOOP
    other_trade:=propose_trade_atomic(league,season,members[1],members[2],ARRAY[v_players[3]],ARRAY[v_players[5]],'{}','{}');
    PERFORM set_trade_roster_plan_atomic(other_trade,members[1],users[1],'{}','{}',ARRAY[v_players[2]]);
    SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO before_rosters FROM roster_players roster WHERE league_season_id=season;
    IF v_terminal='rejected' THEN
      PERFORM reject_trade_atomic(other_trade,members[2],users[2]);
    ELSIF v_terminal='withdrawn' THEN
      PERFORM withdraw_trade_atomic(other_trade,members[1],users[1]);
    ELSIF v_terminal='expired' THEN
      UPDATE trades SET expires_at=now()-interval '1 minute' WHERE id=other_trade;
      PERFORM expire_pending_trades_atomic(500);
    ELSE
      PERFORM accept_trade_atomic(other_trade,members[2]);
      PERFORM veto_trade_atomic(other_trade,members[3]);
    END IF;
    SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO after_rosters FROM roster_players roster WHERE league_season_id=season;
    PERFORM pg_temp.check_plan(before_rosters=after_rosters,'terminal '||v_terminal||' applies no roster plan');
  END LOOP;
  trade:=propose_trade_atomic(league,season,members[1],members[2],ARRAY[v_players[3]],ARRAY[v_players[5]],'{}','{}');
  other_trade:=propose_trade_atomic(league,season,members[1],members[2],ARRAY[v_players[3]],ARRAY[v_players[5]],'{}','{}');
  claim:=create_waiver_claim_atomic(league,members[1],v_players[6],v_players[3],users[1]);
  PERFORM accept_trade_atomic(trade,members[2]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  PERFORM complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.check_plan((SELECT status='cancelled' AND failure_reason LIKE '%left this roster%' AND processed_at IS NOT NULL FROM waiver_claims WHERE id=claim),'completion cancels dependent waiver claim with visible reason');
  PERFORM pg_temp.check_plan(EXISTS(SELECT 1 FROM notification_outbox WHERE dedupe_key='trade_claim_cancelled:'||claim),'dependent claim cancellation enters transactional notification outbox');
  PERFORM pg_temp.check_plan((SELECT trades.status='expired' AND completion_failure_reason IS NOT NULL FROM trades WHERE id=other_trade),'completion invalidates overlapping pending asset offer');
  other_trade:=propose_trade_atomic(league,season,members[1],members[2],ARRAY[v_players[5]],ARRAY[v_players[3]],'{}','{}');
  claim:=create_waiver_claim_atomic(league,members[1],v_players[6],v_players[5],users[1]);
  UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE id=wire;
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  UPDATE waiver_wire_log SET clears_at=now()-interval '2 days' WHERE league_season_id=season AND player_id=(SELECT player_id FROM waiver_claims WHERE id=claim);
  PERFORM process_next_waiver_claim_atomic((SELECT process_date FROM waiver_claims WHERE id=claim));
  PERFORM pg_temp.check_plan((SELECT status='succeeded' FROM waiver_claims WHERE id=claim),'real waiver pickup settles its drop and add');
  PERFORM pg_temp.check_plan((SELECT trades.status='expired' AND completion_failure_reason IS NOT NULL FROM trades WHERE id=other_trade),'waiver completion invalidates dependent pending trade with explicit reason');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(v_picks[1],league,8301,1,members[3],members[3]),(v_picks[2],league,8301,2,members[3],members[3]);
  trade:=propose_trade_atomic(league,season,members[1],members[3],ARRAY[v_players[2]],'{}','{}',ARRAY[v_picks[1]]);
  PERFORM accept_trade_atomic(trade,members[3]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  v_players:=array_append(v_players,gen_random_uuid());
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,years_exp)
  VALUES(v_players[7],'Plan','Waiver arrival','PG',ARRAY['PG'],3);
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,dropped_by_member_id,clears_at)
  VALUES(league,season,v_players[7],members[2],now()-interval '1 minute');
  UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE league_season_id=season AND player_id=v_players[7];
  claim:=create_waiver_claim_atomic(league,members[3],v_players[7],NULL,users[3]);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  UPDATE waiver_wire_log SET clears_at=now()-interval '2 days' WHERE league_season_id=season AND player_id=(SELECT player_id FROM waiver_claims WHERE id=claim);
  PERFORM process_next_waiver_claim_atomic((SELECT process_date FROM waiver_claims WHERE id=claim));
  PERFORM pg_temp.check_plan((SELECT status='succeeded' FROM waiver_claims WHERE id=claim),
    'legal waiver pickup fills future receipt space: '||(SELECT status||COALESCE(' '||failure_reason,'') FROM waiver_claims WHERE id=claim));
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO before_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'active roster limit','actual waiver pickup makes accepted future receipt illegal');
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO after_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.check_plan(before_rosters=after_rosters,'waiver changed roster refusal has no partial effect');
  DELETE FROM roster_players WHERE league_season_id=season AND player_id=v_players[7];
  other_trade:=propose_trade_atomic(league,season,members[1],members[3],ARRAY[v_players[6]],'{}','{}',ARRAY[v_picks[2]]);
  PERFORM accept_trade_atomic(other_trade,members[3]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=other_trade;
  PERFORM complete_accepted_trade_atomic(other_trade);
  PERFORM pg_temp.check_plan((SELECT member_id=members[3] FROM roster_players WHERE league_season_id=season AND player_id=v_players[6]),'another independent trade legally fills future receipt space');
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO before_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.fail_plan(format('SELECT complete_accepted_trade_atomic(%L)',trade),'active roster limit','another completed trade makes earlier accepted plan illegal');
  SELECT jsonb_agg(to_jsonb(roster) ORDER BY id) INTO after_rosters FROM roster_players roster WHERE league_season_id=season;
  PERFORM pg_temp.check_plan(before_rosters=after_rosters,'trade changed roster refusal has no partial effect');

END;
$$;
SELECT count(*) AS passed_checks FROM plan_checks;
ROLLBACK;
