CREATE TEMP TABLE l4_batch_context(league_id uuid,season_id uuid,member_ids uuid[],trade_ids uuid[]);
CREATE FUNCTION pg_temp.l4_batch_fixture(p_count integer,p_cached boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE f record; v_trade uuid; v_ids uuid[]:=ARRAY[]::uuid[]; v_pick uuid:=gen_random_uuid(); v_player uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9640);
  FOR n IN 1..p_count LOOP
    v_player:=gen_random_uuid();
    v_pick:=gen_random_uuid();
    INSERT INTO public.players(id,first_name,last_name,nba_team) VALUES(v_player,'Batch','Fixture','BOS');
    INSERT INTO public.draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
      VALUES(v_pick,f.league_id,9641,n,f.member_ids[2],f.member_ids[2]);
    INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
      VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],CASE WHEN n%2=0 THEN 'accepted'::public.trade_status ELSE 'pending'::public.trade_status END) RETURNING id INTO v_trade;
    INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
      VALUES(v_trade,f.league_id,f.member_ids[1],now(),0,true),(v_trade,f.league_id,f.member_ids[2],now(),1,false);
    INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,faab_amount,side)
      VALUES(f.league_id,v_trade,f.member_ids[1],f.member_ids[2],n,'proposer');
    INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,player_id,pick_id,side)
      VALUES(f.league_id,v_trade,f.member_ids[2],f.member_ids[1],CASE WHEN n%2=0 THEN v_player END,CASE WHEN n%2=1 THEN v_pick END,'recipient');
    v_ids:=array_append(v_ids,v_trade);
  END LOOP;
  INSERT INTO l4_batch_context VALUES(f.league_id,f.season_id,f.member_ids,v_ids);
  IF p_cached THEN
    INSERT INTO public.trade_value_cache(trade_id,league_id,league_season_id,revaluation,valid_until,version)
      SELECT id,f.league_id,f.season_id,'{}','infinity',1 FROM unnest(v_ids) id;
    INSERT INTO private.trade_value_publications(trade_id,version,valid_until,input_fingerprint,model_version)
      SELECT id,1,'infinity',private.trade_revaluation_input_version(id),'batch-fixture' FROM unnest(v_ids) id;
  END IF;
END $$;
CREATE FUNCTION pg_temp.l4_batch_cycle() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE f record; item record; v_calls integer:=1;
BEGIN
  SELECT * INTO f FROM l4_batch_context;
  PERFORM public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','queue-trades','seasonId',f.season_id,'version',987654,'modelVersion','batch-fixture'));
  FOR item IN SELECT id,payload FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-check' ORDER BY id LOOP
    PERFORM public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','check-trade','tradeId',item.payload->>'tradeId','modelVersion','batch-fixture'));
    UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE id=item.id;
    v_calls:=v_calls+1;
  END LOOP;
  RETURN v_calls;
END $$;
