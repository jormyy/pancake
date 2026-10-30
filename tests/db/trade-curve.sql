BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  terms jsonb; inputs jsonb; historical jsonb; offer uuid; q uuid; retry uuid; fingerprint text; cached jsonb; cards jsonb;
  analysis jsonb; published boolean;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9590);
  UPDATE public.leagues SET roster_size=2,ir_slots=1,taxi_slots=1 WHERE id=f.league_id;
  INSERT INTO public.players(id,first_name,last_name,nba_team,position,eligible_positions,years_exp)
    SELECT id,'Curve','Player '||ordinal,'OKC','PG',ARRAY['PG'],3 FROM unnest(p) WITH ORDINALITY row(id,ordinal);
  INSERT INTO public.dynasty_rankings(player_id,source,source_rank,source_player_id,source_player_name,trade_value,fetched_at)
    SELECT id,'onenumberhoops.com',10000+ordinal,id::text,'Curve fixture '||ordinal,CASE ordinal WHEN 1 THEN 950 WHEN 2 THEN 500 ELSE 1000 END,now()
      FROM unnest(p) WITH ORDINALITY row(id,ordinal);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p[1],'draft'),(f.league_id,f.season_id,f.member_ids[2],p[2],'draft');
  terms:=jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'playerId',p[1]),
    jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[1],'playerId',p[2]));
  inputs:=public.get_trade_estimate_inputs(f.user_ids[1],f.member_ids[1],terms);
  PERFORM pg_temp.check_rules(jsonb_array_length(inputs->'rosters')=2,'both real rosters are frozen');
  PERFORM pg_temp.check_rules((inputs->>'bestFreeAgentValue')::numeric=1000,'best market free agent needs no fantasy average');
  PERFORM pg_temp.check_rules((SELECT bool_and((team->'limits'->>'active')::int=2) FROM jsonb_array_elements(inputs->'rosters') team),'regular limits are distinct from IR and taxi');
  PERFORM pg_temp.check_rules((SELECT (player->>'trade_value')::numeric=950 FROM jsonb_array_elements(inputs->'players') player WHERE player->>'player_id'=p[1]::text),'source inputs stay uncurved');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM jsonb_array_elements(inputs->'rosters') team,jsonb_array_elements(team->'players') player WHERE (player->>'tradeValue')::numeric IN(500,950)),'incumbents retain their source values');
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'pending') RETURNING id INTO offer;
  INSERT INTO public.trade_items(trade_id,from_member_id,to_member_id,player_id,side)
    VALUES(offer,f.member_ids[1],f.member_ids[2],p[1],'proposer'),(offer,f.member_ids[2],f.member_ids[1],p[2],'recipient');
  INSERT INTO public.trade_estimates(trade_id,unavailable_reason) VALUES(offer,'Pending calculation') ON CONFLICT DO NOTHING;
  inputs:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],offer);
  fingerprint:=inputs->>'inputVersion';
  PERFORM pg_temp.check_rules(fingerprint=private.trade_revaluation_input_version(offer),'revaluation keeps the existing fingerprint');
  PERFORM pg_temp.check_rules(inputs->'playerDestinations'->>p[1]::text='active','revaluation includes incoming destinations without changing terms');
  analysis:=jsonb_build_object('teams',jsonb_build_array(
    jsonb_build_object('memberId',f.member_ids[1],'valuesSent',773.780937,'valuesReceived',31.25,'rosterSlotEffect',0,'netValue',-742.530937),
    jsonb_build_object('memberId',f.member_ids[2],'valuesSent',31.25,'valuesReceived',773.780937,'rosterSlotEffect',0,'netValue',742.530937)),
    'assets','[]'::jsonb);
  cached:=jsonb_build_object('modelVersion','onenumber-trade-curve-v5','inputVersion',fingerprint,'analysis',analysis,'createdAt',now());
  published:=private.refresh_trade_values(f.league_id,f.season_id,1,jsonb_build_array(jsonb_build_object('tradeId',offer,'revaluation',cached)));
  PERFORM pg_temp.check_rules(published,'refresh publishes the already curved estimate');
  PERFORM pg_temp.check_rules(private.refresh_trade_values(f.league_id,f.season_id,1,jsonb_build_array(jsonb_build_object('tradeId',offer,'revaluation',cached))),'refresh replay succeeds');
  PERFORM pg_temp.check_rules((SELECT revaluation=cached FROM public.trade_value_cache WHERE trade_id=offer),'publication neither curves again nor drops roster terms');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  cards:=public.get_trade_cards(f.league_id,f.member_ids[1],ARRAY[offer]);
  PERFORM pg_temp.check_rules(cards->0->'estimate'->'teams'=analysis->'teams','Trades list reads the current publication');
  INSERT INTO public.trade_estimate_history(trade_id,formula_version,snapshot)
    VALUES(offer,'onenumber-trade-curve-v4','{}'::jsonb);
  historical:=public.get_trade_estimate_reanalysis_inputs(offer);
  PERFORM pg_temp.check_rules(historical IS NOT NULL,'the exponent 5 model recomputes trades with prior curved-model history');
  q:=public.save_trade_estimate_reanalysis(offer,historical,analysis);
  retry:=public.save_trade_estimate_reanalysis(offer,historical,analysis);
  PERFORM pg_temp.check_rules(q=retry,'model recomputation runs once per trade');
  PERFORM pg_temp.check_rules((SELECT model_version='onenumber-trade-curve-v5' FROM public.trade_estimate_quotes WHERE id=q),'stored model version is bumped');
  PERFORM pg_temp.check_rules(public.get_trade_estimate_reanalysis_inputs(offer) IS NULL,'repeat model input request skips completed work');
  PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM public.trade_estimate_history WHERE trade_id=offer),'original, prior model, and current model histories are retained');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.build_trade_estimate_inputs(uuid,uuid,jsonb,boolean)','EXECUTE'),'raw roster inputs remain service only');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
