BEGIN;

CREATE FUNCTION pg_temp.reject_retry_test_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.trades
    WHERE id = (NEW.data->>'tradeId')::uuid
      AND notes = 'retry rollback fault'
  ) THEN
    RAISE EXCEPTION 'retry rollback fault injected' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_other_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_actions text[] := ARRAY['propose','propose-multi','edit','counter','edit-multi','counter-multi'];
  v_action text;
  v_multi boolean;
  v_counter boolean;
  v_actor int;
  v_key uuid;
  v_source uuid;
  v_first uuid;
  v_second uuid;
  v_payload jsonb;
  v_terms jsonb;
  v_multi_terms jsonb;
  v_trade_count bigint;
  v_outbox_count bigint;
  v_activity_count bigint;
  v_rejected boolean;
  v_completed boolean;
  v_change jsonb;
  v_extra_member uuid := gen_random_uuid();
  v_receipt_result uuid;
  i int;
BEGIN
  FOR i IN 1..4 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_users[i],'authenticated','authenticated',v_users[i]||'@example.test',
      'x',now(),'{}','{}',now(),now());
  END LOOP;
  INSERT INTO leagues(id,name,slug,commissioner_id,status,waiver_mode)
  VALUES(v_league,'Trade retry regression',v_league::text,v_users[1],'active','faab'),
        (v_other_league,'Trade retry foreign actor',v_other_league::text,v_users[4],'active','faab');
  FOR i IN 1..4 LOOP
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(v_members[i],CASE WHEN i=4 THEN v_other_league ELSE v_league END,v_users[i],
      CASE WHEN i IN (1,4) THEN 'commissioner'::league_member_role ELSE 'manager'::league_member_role END,
      'Retry '||i);
  END LOOP;
  INSERT INTO league_seasons(id,league_id,season_year,is_current)
  VALUES(v_season,v_league,2161,true);
  INSERT INTO faab_balances(league_id,league_season_id,member_id,balance)
  SELECT v_league,v_season,v_members[n],100 FROM generate_series(1,3) n
  ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;

  v_terms := jsonb_build_object(
    'offerPlayerIds','[]'::jsonb,'requestPlayerIds','[]'::jsonb,
    'offerPickIds','[]'::jsonb,'requestPickIds','[]'::jsonb,
    'offerFaabAmount',1,'requestFaabAmount',1,
    'notes','retry sequential offer','expiresAt',now()+interval '1 day');
  v_multi_terms := jsonb_build_object(
    'participantMemberIds',to_jsonb(v_members[1:3]),
    'items',jsonb_build_array(
      jsonb_build_object('fromMemberId',v_members[1],'toMemberId',v_members[2],'faabAmount',1),
      jsonb_build_object('fromMemberId',v_members[1],'toMemberId',v_members[3],'faabAmount',1)),
    'notes','retry sequential multi offer','expiresAt',now()+interval '1 day');

  -- An accepted multi-team participant cannot regain a counter through the two-team route.
  v_source := public.propose_multi_team_trade_atomic(v_league,v_season,v_members[1],v_members[1:3],
    v_multi_terms->'items','accepted multi source',now()+interval '1 day');
  PERFORM public.accept_trade_atomic(v_source,v_members[2]);
  IF (SELECT status::text FROM trades WHERE id=v_source)<>'pending'
    OR NOT EXISTS(SELECT 1 FROM trade_participants WHERE trade_id=v_source AND member_id=v_members[2] AND accepted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Multi accepted fixture was not pending with one acceptance';
  END IF;
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[2],gen_random_uuid(),v_members[2],'counter-multi',
      v_multi_terms||jsonb_build_object('tradeId',v_source));
  EXCEPTION WHEN SQLSTATE '42501' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Accepted participant can use the proper multi counter'; END IF;
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[2],gen_random_uuid(),v_members[2],'counter',
      v_terms||jsonb_build_object('tradeId',v_source));
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
  END;
  IF NOT v_rejected OR (SELECT status::text FROM trades WHERE id=v_source)<>'pending' THEN
    RAISE EXCEPTION 'Accepted multi participant bypassed the restriction through two-team counter';
  END IF;
  -- A still-unaccepted participant uses the correct multi-team route successfully.
  v_first := public.submit_trade_offer_atomic(v_users[3],gen_random_uuid(),v_members[3],'counter-multi',
    v_multi_terms||jsonb_build_object('tradeId',v_source));
  IF v_first IS NULL OR (SELECT replaced_by_trade_id FROM trades WHERE id=v_source)<>v_first THEN
    RAISE EXCEPTION 'Unaccepted participant cannot legally counter';
  END IF;

  FOREACH v_action IN ARRAY v_actions LOOP
    v_multi := v_action LIKE '%multi';
    v_counter := v_action IN ('counter','counter-multi');
    v_actor := CASE WHEN v_counter THEN 2 ELSE 1 END;
    v_key := gen_random_uuid();
    v_source := NULL;
    v_payload := CASE WHEN v_multi THEN v_multi_terms ELSE v_terms END;
    IF v_action IN ('propose','propose-multi') THEN
      v_payload := v_payload || jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season);
      IF NOT v_multi THEN
        v_payload := v_payload || jsonb_build_object('recipientMemberId',v_members[2]);
      END IF;
    ELSE
      -- Existing trusted RPCs seed sources. Their signatures remain unchanged.
      IF v_multi THEN
        v_source := public.propose_multi_team_trade_atomic(
          v_league,v_season,v_members[1],v_members[1:3],v_multi_terms->'items',
          'retry source',now()+interval '1 day');
      ELSE
        v_source := public.propose_trade_atomic(v_league,v_season,v_members[1],v_members[2],
          ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],
          'retry source',now()+interval '1 day',1,1);
      END IF;
      v_payload := v_payload || jsonb_build_object('tradeId',v_source);
    END IF;

    SELECT count(*) INTO v_trade_count FROM public.trades WHERE league_id=v_league;
    v_first := public.submit_trade_offer_atomic(v_users[v_actor],v_key,v_members[v_actor],v_action,v_payload);
    IF v_first IS NULL THEN RAISE EXCEPTION '% unexpectedly returned NULL',v_action; END IF;
    IF (SELECT count(*) FROM public.trades WHERE league_id=v_league) <> v_trade_count+1 THEN
      RAISE EXCEPTION '% did not create exactly one offer',v_action;
    END IF;
    SELECT count(*) INTO v_outbox_count FROM public.notification_outbox
      WHERE data @> jsonb_build_object('tradeId',v_first);
    IF v_outbox_count <> (CASE WHEN v_multi THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION '% unexpected recipient notification count %',v_action,v_outbox_count;
    END IF;
    IF EXISTS (
      SELECT 1 FROM notification_outbox WHERE data @> jsonb_build_object('tradeId',v_first)
        AND (event_type <> CASE WHEN v_counter THEN 'trade_countered' WHEN v_action LIKE 'edit%' THEN 'trade_edited' ELSE 'trade_offered' END
          OR title <> CASE WHEN v_counter THEN CASE WHEN v_multi THEN 'Multi-Team Trade Countered' ELSE 'Trade Countered' END
            WHEN v_action LIKE 'edit%' THEN CASE WHEN v_multi THEN 'Multi-Team Trade Edited' ELSE 'Trade Edited' END
            ELSE CASE WHEN v_multi THEN 'New Multi-Team Trade' ELSE 'New Trade Offer' END END
          OR member_id NOT IN (SELECT member_id FROM trade_participants WHERE trade_id=v_first AND NOT is_initiator))
    ) THEN RAISE EXCEPTION '% incorrect notification kind/title/recipient',v_action; END IF;
    SELECT count(*) INTO v_activity_count FROM public.league_activity WHERE related_trade_id=v_first;
    IF v_activity_count <> 1 THEN RAISE EXCEPTION '% activity count is %',v_action,v_activity_count; END IF;
    v_second := public.submit_trade_offer_atomic(v_users[v_actor],v_key,v_members[v_actor],v_action,v_payload);
    IF v_second IS DISTINCT FROM v_first THEN RAISE EXCEPTION '% replay changed result',v_action; END IF;
    IF (SELECT count(*) FROM public.trades WHERE league_id=v_league) <> v_trade_count+1
      OR (SELECT count(*) FROM public.notification_outbox WHERE data @> jsonb_build_object('tradeId',v_first)) <> v_outbox_count
      OR (SELECT count(*) FROM public.league_activity WHERE related_trade_id=v_first) <> v_activity_count THEN
      RAISE EXCEPTION '% replay wrote rows',v_action;
    END IF;
    SELECT completed,result_trade_id INTO v_completed,v_receipt_result
      FROM private.trade_offer_requests WHERE user_id=v_users[v_actor] AND request_id=v_key;
    IF v_completed IS DISTINCT FROM true OR v_receipt_result IS DISTINCT FROM v_first THEN
      RAISE EXCEPTION '% missing completed receipt',v_action;
    END IF;

    v_rejected := false;
    BEGIN
      PERFORM public.submit_trade_offer_atomic(v_users[v_actor],v_key,v_members[v_actor],v_action,
        v_payload || jsonb_build_object('notes','changed retry note'));
    EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION '% changed payload did not conflict',v_action; END IF;
    IF (SELECT count(*) FROM public.trades WHERE league_id=v_league) <> v_trade_count+1 THEN
      RAISE EXCEPTION '% payload conflict wrote an offer',v_action;
    END IF;

    IF v_source IS NOT NULL THEN
      IF (SELECT replaced_by_trade_id FROM public.trades WHERE id=v_source) IS DISTINCT FROM v_first
        OR (SELECT version FROM public.trades WHERE id=v_first) <> (SELECT version+1 FROM public.trades WHERE id=v_source)
        OR (v_counter AND (SELECT countered_from_trade_id FROM public.trades WHERE id=v_first) IS DISTINCT FROM v_source)
        OR (NOT v_counter AND (SELECT edited_from_trade_id FROM public.trades WHERE id=v_first) IS DISTINCT FROM v_source)
        OR (SELECT status::text FROM public.trades WHERE id=v_source) <> (CASE WHEN v_counter THEN 'countered' ELSE 'edited' END) THEN
        RAISE EXCEPTION '% incorrect source lineage',v_action;
      END IF;
    ELSE
      v_second := public.submit_trade_offer_atomic(v_users[1],gen_random_uuid(),v_members[1],v_action,v_payload);
      IF v_second IS NULL OR v_second=v_first THEN RAISE EXCEPTION '% identical new intent was deduplicated',v_action; END IF;
    END IF;
  END LOOP;

  -- Every typed term participates in the receipt, including empty arrays and absolute expiration.
  v_payload := v_terms || jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season,
    'recipientMemberId',v_members[2]);
  v_key := gen_random_uuid();
  SET LOCAL ROLE service_role;
  v_first := public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'propose',v_payload);
  RESET ROLE;
  SELECT count(*) INTO v_trade_count FROM trades WHERE league_id=v_league;
  FOR v_change IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('offerPlayerIds',jsonb_build_array(gen_random_uuid())),
    jsonb_build_object('requestPlayerIds',jsonb_build_array(gen_random_uuid())),
    jsonb_build_object('offerPickIds',jsonb_build_array(gen_random_uuid())),
    jsonb_build_object('requestPickIds',jsonb_build_array(gen_random_uuid())),
    jsonb_build_object('offerFaabAmount',2), jsonb_build_object('requestFaabAmount',2),
    jsonb_build_object('recipientMemberId',v_members[3]),
    jsonb_build_object('leagueId',v_other_league), jsonb_build_object('leagueSeasonId',gen_random_uuid()),
    jsonb_build_object('expiresAt',now()+interval '2 days'), jsonb_build_object('notes',NULL)
  )) LOOP
    v_rejected := false;
    BEGIN
      PERFORM public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'propose',v_payload||v_change);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'Changed field did not conflict: %',v_change; END IF;
  END LOOP;
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'edit',
      v_terms||jsonb_build_object('tradeId',v_first));
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Changed action did not conflict'; END IF;
  INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(v_extra_member,v_other_league,v_users[1],'manager','Second membership');
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[1],v_key,v_extra_member,'propose',
      v_payload||jsonb_build_object('leagueId',v_other_league));
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Another membership replayed the first member result'; END IF;

  -- A user's key cannot disclose another user's result or authorize another member.
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[2],v_key,v_members[1],'propose',v_payload);
  EXCEPTION WHEN SQLSTATE '42501' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Wrong user accessed the receipt'; END IF;
  v_second := public.submit_trade_offer_atomic(v_users[2],v_key,v_members[2],'propose',
    v_payload||jsonb_build_object('recipientMemberId',v_members[1]));
  IF v_second IS NULL OR v_second=v_first THEN RAISE EXCEPTION 'Two users share one receipt'; END IF;
  IF (SELECT count(*) FROM trades WHERE league_id=v_league)<>v_trade_count+1 THEN
    RAISE EXCEPTION 'Conflict controls created an offer';
  END IF;

  -- Current ownership is mandatory, while mutable balances do not invalidate a committed receipt.
  UPDATE league_members SET user_id=v_users[4] WHERE id=v_members[1];
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'propose',v_payload);
  EXCEPTION WHEN SQLSTATE '42501' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Former owner accessed the receipt'; END IF;
  UPDATE league_members SET user_id=v_users[1] WHERE id=v_members[1];
  UPDATE faab_balances SET balance=0 WHERE league_season_id=v_season AND member_id=v_members[1];
  IF public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'propose',v_payload)<>v_first THEN
    RAISE EXCEPTION 'Balance changes lost committed result';
  END IF;
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[1],gen_random_uuid(),v_members[1],'propose',v_payload);
  EXCEPTION WHEN OTHERS THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'New requests bypassed the existing FAAB guard'; END IF;
  UPDATE faab_balances SET balance=100 WHERE league_season_id=v_season AND member_id=v_members[1];

  -- Role grants are tested by actual calls, not only catalog inspection.
  FOREACH v_action IN ARRAY ARRAY['anon','authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I',v_action);
    v_rejected := false;
    BEGIN
      PERFORM public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'propose',v_payload);
    EXCEPTION WHEN insufficient_privilege THEN v_rejected := true;
    END;
    RESET ROLE;
    IF NOT v_rejected THEN RAISE EXCEPTION '% can call receipt wrapper',v_action; END IF;
  END LOOP;
  IF has_table_privilege('anon','private.trade_offer_requests','SELECT')
    OR has_table_privilege('authenticated','private.trade_offer_requests','SELECT')
    OR has_table_privilege('service_role','private.trade_offer_requests','SELECT') THEN
    RAISE EXCEPTION 'Receipt table has unexpected direct access';
  END IF;

  -- Authorized NULL versus unrelated owned actors on the same expired source.
  v_source := public.propose_trade_atomic(v_league,v_season,v_members[1],v_members[2],
    ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],'retry expired source',NULL,1,1);
  UPDATE public.trades SET expires_at=now()-interval '1 minute' WHERE id=v_source;
  v_payload := v_terms || jsonb_build_object('tradeId',v_source);
  FOR i IN 3..4 LOOP
    v_rejected := false;
    BEGIN
      PERFORM public.submit_trade_offer_atomic(v_users[i],gen_random_uuid(),v_members[i],'edit',v_payload);
    EXCEPTION WHEN SQLSTATE '42501' THEN v_rejected := true;
    END;
    IF NOT v_rejected OR (SELECT status::text FROM public.trades WHERE id=v_source)<>'pending' THEN
      RAISE EXCEPTION 'Unrelated owned actor % can expire the source',i;
    END IF;
  END LOOP;
  v_key := gen_random_uuid();
  v_first := public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'edit',v_payload);
  v_second := public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'edit',v_payload);
  SELECT completed,result_trade_id INTO v_completed,v_receipt_result
    FROM private.trade_offer_requests WHERE user_id=v_users[1] AND request_id=v_key;
  IF v_first IS NOT NULL OR v_second IS NOT NULL OR v_completed IS DISTINCT FROM true
    OR v_receipt_result IS NOT NULL OR (SELECT status::text FROM public.trades WHERE id=v_source)<>'expired' THEN
    RAISE EXCEPTION 'Committed NULL replay is incorrect';
  END IF;

  -- Fault after an offer and notification insertion, then retry the rolled-back key.
  CREATE TRIGGER retry_test_notification_fault AFTER INSERT ON public.notification_outbox
    FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_retry_test_notification();
  v_key := gen_random_uuid();
  v_payload := v_terms || jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season,
    'recipientMemberId',v_members[2],'notes','retry rollback fault');
  SELECT count(*) INTO v_trade_count FROM public.trades WHERE league_id=v_league;
  v_rejected := false;
  BEGIN
    PERFORM public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'propose',v_payload);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'retry rollback fault injected' THEN RAISE; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected
    OR EXISTS(SELECT 1 FROM private.trade_offer_requests WHERE user_id=v_users[1] AND request_id=v_key)
    OR (SELECT count(*) FROM public.trades WHERE league_id=v_league)<>v_trade_count THEN
    RAISE EXCEPTION 'Late fault did not roll back receipt and offer';
  END IF;
  DROP TRIGGER retry_test_notification_fault ON public.notification_outbox;
  v_first := public.submit_trade_offer_atomic(v_users[1],v_key,v_members[1],'propose',v_payload);
  IF v_first IS NULL OR (SELECT count(*) FROM public.trades WHERE league_id=v_league)<>v_trade_count+1 THEN
    RAISE EXCEPTION 'Rolled-back key cannot be reused safely';
  END IF;
END;
$$;
ROLLBACK;

