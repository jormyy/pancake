BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_outgoing uuid;
  v_incoming uuid;
  v_veto uuid;
  v_history uuid;
  v_status public.trade_status;
  v_refs uuid[];
  v_cursor text;
  v_page uuid;
  v_batch uuid[];
  v_tokens text[];
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
  v_outgoing := public.propose_trade_atomic(v_league,v_season,v_members[1],v_members[2],
    ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],NULL,NULL,1,1);
  v_incoming := public.propose_trade_atomic(v_league,v_season,v_members[3],v_members[1],
    ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],NULL,NULL,1,1);
  FOREACH v_status IN ARRAY ARRAY['completed','rejected','countered','edited','expired','vetoed','accepted']::public.trade_status[] LOOP
    INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status,proposed_at)
      VALUES(v_league,v_season,v_members[1],v_members[2],v_status,now()+interval '1 day') RETURNING id INTO v_history;
    INSERT INTO public.trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
      VALUES(v_history,v_members[1],0,true,now()),(v_history,v_members[2],1,false,NULL);
  END LOOP;
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status,proposed_at,accepted_at,veto_window_expires_at)
    VALUES(v_league,v_season,v_members[2],v_members[3],'accepted',now(),now(),now()+interval '1 hour') RETURNING id INTO v_veto;
  INSERT INTO public.trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
    VALUES(v_veto,v_members[2],0,true,now()),(v_veto,v_members[3],1,false,now());
  PERFORM set_config('request.jwt.claim.sub',v_users[1]::text,true);
  SELECT array_agg(trade_id) INTO v_refs FROM public.get_trade_page_refs(v_members[1],v_league,40,NULL);
  IF cardinality(v_refs)<>3 OR NOT v_refs @> ARRAY[v_incoming,v_outgoing,v_veto] THEN
    RAISE EXCEPTION 'Offers page includes hidden history or loses a visible trade: %',v_refs;
  END IF;
  SELECT trade_id,cursor_token INTO v_page,v_cursor FROM public.get_trade_page_refs(v_members[1],v_league,1,NULL);
  IF v_page IS DISTINCT FROM v_incoming THEN RAISE EXCEPTION 'Incoming offer is not first'; END IF;
  SELECT trade_id,cursor_token INTO v_page,v_cursor FROM public.get_trade_page_refs(v_members[1],v_league,1,v_cursor);
  IF v_page IS DISTINCT FROM v_veto THEN RAISE EXCEPTION 'Observer veto window is not second'; END IF;
  SELECT trade_id,cursor_token INTO v_page,v_cursor FROM public.get_trade_page_refs(v_members[1],v_league,1,v_cursor);
  IF v_page IS DISTINCT FROM v_outgoing THEN RAISE EXCEPTION 'Outgoing pending offer is not third'; END IF;
  IF EXISTS(SELECT 1 FROM public.get_trade_page_refs(v_members[1],v_league,1,v_cursor)) THEN
    RAISE EXCEPTION 'Pagination continues into hidden history';
  END IF;

  WITH inserted AS (
    INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status,proposed_at)
      SELECT v_league,v_season,v_members[1],v_members[2],'completed',now()+n*interval '1 second'
        FROM generate_series(1,2000) n RETURNING id
  )
  INSERT INTO public.trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
    SELECT id,v_members[1],0,true,now() FROM inserted
    UNION ALL SELECT id,v_members[2],1,false,now() FROM inserted;
  WITH inserted AS (
    INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status,proposed_at)
      SELECT v_league,v_season,v_members[1],v_members[2],'pending',now()+n*interval '1 second'
        FROM generate_series(1,80) n RETURNING id
  )
  INSERT INTO public.trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
    SELECT id,v_members[1],0,true,now() FROM inserted
    UNION ALL SELECT id,v_members[2],1,false,NULL FROM inserted;
  v_refs := ARRAY[]::uuid[];
  v_cursor := NULL;
  LOOP
    SELECT array_agg(trade_id ORDER BY ordinal),array_agg(cursor_token ORDER BY ordinal)
      INTO v_batch,v_tokens FROM public.get_trade_page_refs(v_members[1],v_league,40,v_cursor)
      WITH ORDINALITY AS refs(trade_id,cursor_token,ordinal);
    EXIT WHEN v_batch IS NULL;
    IF v_refs && v_batch OR EXISTS(SELECT 1 FROM public.trades WHERE id=ANY(v_batch) AND status NOT IN ('pending','accepted')) THEN
      RAISE EXCEPTION 'Offer pagination repeats a row or consumes hidden history';
    END IF;
    v_refs := v_refs||v_batch;
    IF cardinality(v_refs)>83 THEN RAISE EXCEPTION 'Offer pagination does not stop at visible trades'; END IF;
    v_cursor := v_tokens[cardinality(v_tokens)];
  END LOOP;
  IF cardinality(v_refs)<>83 OR NOT v_refs @> ARRAY[v_incoming,v_outgoing,v_veto] THEN
    RAISE EXCEPTION 'Large history displaces visible offers';
  END IF;
END;
$$;
ROLLBACK;
