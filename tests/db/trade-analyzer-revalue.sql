BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; trade uuid; fingerprint text; cached jsonb; result jsonb; version bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9609);
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]) RETURNING id INTO trade;
  INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
    VALUES(trade,f.league_id,f.member_ids[1],now(),0,true),(trade,f.league_id,f.member_ids[2],now(),1,false);
  INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,faab_amount,side)
    VALUES(f.league_id,trade,f.member_ids[1],f.member_ids[2],1,'proposer');
  fingerprint:=private.trade_revaluation_input_version(trade);
  SELECT queued.version INTO version FROM private.screen_refresh_queue queued WHERE league_season_id=f.season_id;
  cached:=jsonb_build_object('tradeId',trade,'inputVersion',fingerprint,'modelVersion','fixture',
    'createdAt',now()-interval '1 hour','expiresAt',now()-interval '50 minutes','analysis','{}'::jsonb);
  PERFORM pg_temp.check_rules(private.refresh_trade_values(f.league_id,f.season_id,version,
    jsonb_build_array(jsonb_build_object('tradeId',trade,'revaluation',cached))),'publishes an unchanged fingerprint');
  result:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->'cachedRevaluation';
  PERFORM pg_temp.check_rules((result->>'expiresAt')::timestamptz>now(),'validated unchanged values receive a current read lease');
  PERFORM pg_temp.check_rules((result->>'expiresAt')::timestamptz=now()+interval '10 minutes','read lease remains bounded');
  PERFORM pg_temp.check_rules(result->'createdAt'=cached->'createdAt','original valuation time is preserved');
  PERFORM pg_temp.check_rules((SELECT revaluation=cached FROM public.trade_value_cache WHERE trade_id=trade),'read lease does not rewrite the stored publication');
  UPDATE public.leagues SET future_pick_years=future_pick_years+1 WHERE id=f.league_id;
  result:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade);
  PERFORM pg_temp.check_rules(result->>'inputVersion'<>fingerprint,'pick window changes the input fingerprint');
  PERFORM pg_temp.check_rules(result->'cachedRevaluation'='null'::jsonb,'changed inputs cannot reuse an old publication');
END;
$$;
SELECT '7 trade analyzer cache checks passed';
ROLLBACK;
