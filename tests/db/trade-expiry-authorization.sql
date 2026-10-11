BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_other_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_trade uuid := gen_random_uuid();
  v_result jsonb;
  v_replacement uuid;
  v_action text;
  v_multi boolean;
  i int;
BEGIN
  FOR i IN 1..5 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_users[i],'authenticated','authenticated',v_users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
  VALUES(v_league,'Expiry Authorization',v_league::text,v_users[1],'active'),
        (v_other_league,'Foreign Expiry',v_other_league::text,v_users[4],'active');
  FOR i IN 1..5 LOOP
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

  -- Editing and countering must check the source role before the expiry write.
  FOREACH v_multi IN ARRAY ARRAY[false,true] LOOP
    UPDATE trades SET is_multi_team=v_multi WHERE id=v_trade;
    IF v_multi THEN
      INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,proposed_at)
      VALUES(v_trade,v_members[3],2,false,now());
    END IF;
    FOREACH v_action IN ARRAY ARRAY['edit','counter'] LOOP
      FOR i IN 4..5 LOOP
        BEGIN
          IF v_multi THEN
            v_replacement := private.replace_multi_team_trade_offer(v_trade,v_members[i],v_users[i],v_action,
              v_members[1:3],'[]'::jsonb);
          ELSE
            v_replacement := private.replace_trade_offer(v_trade,v_members[i],v_users[i],v_action,
              '{}'::uuid[],'{}'::uuid[],'{}'::uuid[],'{}'::uuid[]);
          END IF;
          RAISE EXCEPTION 'Unauthorized % (multi=%) returns %, stored status %',v_action,v_multi,v_replacement,
            (SELECT status FROM trades WHERE id=v_trade);
        EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
        END;
        IF (SELECT status FROM trades WHERE id=v_trade)<>'pending' THEN
          RAISE EXCEPTION 'Rejected replacement changes source state';
        END IF;
      END LOOP;
      -- A member may not act for another user, even with the correct source role.
      i := CASE WHEN v_action='edit' THEN 1 ELSE 2 END;
      BEGIN
        IF v_multi THEN
          PERFORM private.replace_multi_team_trade_offer(v_trade,v_members[i],v_users[5],v_action,
            v_members[1:3],'[]'::jsonb);
        ELSE
          PERFORM private.replace_trade_offer(v_trade,v_members[i],v_users[5],v_action,
            '{}'::uuid[],'{}'::uuid[],'{}'::uuid[],'{}'::uuid[]);
        END IF;
        RAISE EXCEPTION 'Replacement accepts wrong user';
      EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
      END;
      IF v_multi THEN
        v_replacement := private.replace_multi_team_trade_offer(v_trade,v_members[i],v_users[i],v_action,
          v_members[1:3],'[]'::jsonb);
      ELSE
        v_replacement := private.replace_trade_offer(v_trade,v_members[i],v_users[i],v_action,
          '{}'::uuid[],'{}'::uuid[],'{}'::uuid[],'{}'::uuid[]);
      END IF;
      IF v_replacement IS NOT NULL OR (SELECT status FROM trades WHERE id=v_trade)<>'expired' THEN
        RAISE EXCEPTION 'Authorized replacement expiry fails';
      END IF;
      UPDATE trades SET status='pending' WHERE id=v_trade;
    END LOOP;
  END LOOP;

  v_result := accept_trade_atomic(v_trade,v_members[2]);
  IF NOT (v_result->>'expired')::boolean OR (SELECT status FROM trades WHERE id=v_trade) <> 'expired' THEN
    RAISE EXCEPTION 'Authorized expired acceptance no longer expires the offer';
  END IF;
END;
$$;
ROLLBACK;
