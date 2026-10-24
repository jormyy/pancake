BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_action text;
  v_source uuid;
  v_result uuid;
  v_key uuid;
  v_actor int;
  v_recipient int;
  v_terms jsonb;
  v_payload jsonb;
  v_wrong jsonb;
  v_rejected boolean;
  v_count bigint;
  i int;
BEGIN
  FOR i IN 1..3 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_users[i],'authenticated','authenticated',v_users[i]||'@example.test',
      'x',now(),'{}','{}',now(),now());
  END LOOP;
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode)
    VALUES(v_league,'Trade review regression',v_league::text,v_users[1],'active','faab');
  FOR i IN 1..3 LOOP
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      VALUES(v_members[i],v_league,v_users[i],
        CASE WHEN i=1 THEN 'commissioner'::league_member_role ELSE 'manager'::league_member_role END,
        'Team '||i);
  END LOOP;
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
    VALUES(v_season,v_league,2162,true);
  INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
    SELECT v_league,v_season,v_members[n],100 FROM generate_series(1,3) n
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  v_terms := jsonb_build_object(
    'offerPlayerIds','[]'::jsonb,'requestPlayerIds','[]'::jsonb,
    'offerPickIds','[]'::jsonb,'requestPickIds','[]'::jsonb,
    'offerFaabAmount',1,'requestFaabAmount',1,'expiresAt',NULL);
  FOREACH v_action IN ARRAY ARRAY['counter','edit'] LOOP
    v_actor := CASE WHEN v_action='counter' THEN 2 ELSE 1 END;
    v_recipient := CASE WHEN v_action='counter' THEN 1 ELSE 2 END;
    v_source := public.propose_trade_atomic(v_league,v_season,v_members[1],v_members[2],
      ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],NULL,NULL,1,1);
    v_payload := v_terms||jsonb_build_object('tradeId',v_source,'recipientMemberId',v_members[v_recipient]);
    SELECT count(*) INTO v_count FROM public.trades WHERE league_id=v_league;
    FOR v_wrong IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('recipientMemberId',v_members[3]),
      jsonb_build_object('recipientMemberId',NULL)
    )) LOOP
      v_rejected := false;
      BEGIN
        PERFORM public.submit_trade_offer_atomic(v_users[v_actor],gen_random_uuid(),v_members[v_actor],v_action,v_payload||v_wrong);
      EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
      END;
      IF NOT v_rejected OR (SELECT count(*) FROM public.trades WHERE league_id=v_league)<>v_count
        OR (SELECT status FROM public.trades WHERE id=v_source)<>'pending' THEN
        RAISE EXCEPTION '% allowed an unreviewed counterparty: %',v_action,v_wrong;
      END IF;
    END LOOP;
    v_key := gen_random_uuid();
    v_result := public.submit_trade_offer_atomic(v_users[v_actor],v_key,v_members[v_actor],v_action,v_payload);
    IF (SELECT recipient_member_id FROM public.trades WHERE id=v_result) IS DISTINCT FROM v_members[v_recipient] THEN
      RAISE EXCEPTION '% changed the reviewed counterparty',v_action;
    END IF;
    IF public.submit_trade_offer_atomic(v_users[v_actor],v_key,v_members[v_actor],v_action,v_payload) IS DISTINCT FROM v_result THEN
      RAISE EXCEPTION '% retry lost the committed offer',v_action;
    END IF;
    v_rejected := false;
    BEGIN
      PERFORM public.submit_trade_offer_atomic(v_users[v_actor],v_key,v_members[v_actor],v_action,
        v_payload||jsonb_build_object('recipientMemberId',v_members[3]));
    EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION '% replay ignored a changed counterparty',v_action; END IF;
  END LOOP;
END;
$$;
ROLLBACK;
