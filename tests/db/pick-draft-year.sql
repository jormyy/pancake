BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_pick_year(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
DO $$
DECLARE
  users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  league uuid := gen_random_uuid();
  season uuid := gen_random_uuid();
  picks uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  trade uuid;
  reason text;
  i int;
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'Pick labels',league::text,users[1],'offseason');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,2027,true);
  FOR i IN 1..2 LOOP
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i);
    INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(picks[i],league,2028,1,members[i],members[i]);
  END LOOP;
  trade := public.propose_trade_atomic(league,season,members[1],members[2],'{}','{}',ARRAY[picks[1]],ARRAY[picks[2]]);
  UPDATE draft_picks SET current_owner_id=members[2] WHERE id=picks[1];
  SELECT completion_failure_reason INTO reason FROM trades WHERE id=trade;
  PERFORM pg_temp.assert_pick_year(reason='The 2027 round 1 pick is no longer owned by Team 1.','lost pick notice uses calendar draft year');
  UPDATE draft_picks SET current_owner_id=members[1] WHERE id=picks[1];
  trade := public.propose_trade_atomic(league,season,members[1],members[2],'{}','{}',ARRAY[picks[1]],ARRAY[picks[2]]);
  UPDATE draft_picks SET is_used=true,used_at=now() WHERE id=picks[1];
  SELECT completion_failure_reason INTO reason FROM trades WHERE id=trade;
  PERFORM pg_temp.assert_pick_year(reason='The 2027 round 1 pick has been used in the draft.','consumed pick notice uses calendar draft year');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(picks[3],league,2031,1,members[1],members[1]);
  reason := NULL;
  BEGIN
    PERFORM public.propose_trade_atomic(league,season,members[1],members[2],'{}','{}',ARRAY[picks[3]],ARRAY[picks[2]]);
  EXCEPTION WHEN raise_exception THEN reason := SQLERRM;
  END;
  PERFORM pg_temp.assert_pick_year(reason='Only the next three future draft years can be traded.','retained out-of-window pick cannot be offered');
  UPDATE draft_picks SET season_year=2030 WHERE id=picks[3];
  trade := public.propose_trade_atomic(league,season,members[1],members[2],'{}','{}',ARRAY[picks[3]],ARRAY[picks[2]]);
  PERFORM pg_temp.assert_pick_year(trade IS NOT NULL,'third future draft remains tradable');
  UPDATE draft_picks SET season_year=2031 WHERE id=picks[3];
  reason := NULL;
  BEGIN
    PERFORM public.accept_trade_atomic(trade,members[2]);
  EXCEPTION WHEN raise_exception THEN reason := SQLERRM;
  END;
  PERFORM pg_temp.assert_pick_year(reason='Only the next three future draft years can be traded.','acceptance checks the current future draft window');
  UPDATE draft_picks SET season_year=2030 WHERE id=picks[3];
  PERFORM public.accept_trade_atomic(trade,members[2]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=trade;
  PERFORM public.complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.assert_pick_year((SELECT status='completed' FROM trades WHERE id=trade),'third future draft completes its trade');
END;
$$;
ROLLBACK;
