BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_other_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_trade uuid := gen_random_uuid();
  v_result jsonb;
  i int;
BEGIN
  FOR i IN 1..4 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_users[i],'authenticated','authenticated',v_users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
  VALUES(v_league,'Expiry Authorization',v_league::text,v_users[1],'active'),
        (v_other_league,'Foreign Expiry',v_other_league::text,v_users[4],'active');
  FOR i IN 1..4 LOOP
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(v_members[i],CASE WHEN i=4 THEN v_other_league ELSE v_league END,v_users[i],
      CASE WHEN i IN (1,4) THEN 'commissioner'::league_member_role ELSE 'manager'::league_member_role END,'Expiry '||i);
  END LOOP;
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2110,true);
  INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,expires_at)
  VALUES(v_trade,v_league,v_season,v_members[1],v_members[2],now()-interval '1 minute');
  INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,proposed_at,accepted_at)
  VALUES(v_trade,v_members[1],0,true,now(),now()),(v_trade,v_members[2],1,false,now(),NULL);

  -- Both a league outsider and a same-league non-party must fail before any write.
  FOR i IN 3..4 LOOP
    BEGIN
      PERFORM accept_trade_atomic(v_trade,v_members[i]);
      RAISE EXCEPTION 'Non-participant acceptance changed an expired pending trade';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    IF (SELECT status FROM trades WHERE id=v_trade) <> 'pending'
       OR EXISTS(SELECT 1 FROM trade_participants WHERE trade_id=v_trade AND member_id=v_members[2] AND accepted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Rejected acceptance changes trade state';
    END IF;
  END LOOP;

  v_result := accept_trade_atomic(v_trade,v_members[2]);
  IF NOT (v_result->>'expired')::boolean OR (SELECT status FROM trades WHERE id=v_trade) <> 'expired' THEN
    RAISE EXCEPTION 'Authorized expired acceptance no longer expires the offer';
  END IF;
END;
$$;
ROLLBACK;
