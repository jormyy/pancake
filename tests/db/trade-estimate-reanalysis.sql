BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; other record; ids uuid[]:='{}'; v_trade uuid; inputs jsonb; old_quote uuid; new_quote uuid; retry_quote uuid;
  original jsonb; analysis jsonb:='{"teams":[],"assets":[]}'::jsonb; before_count bigint; after_count bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9590);
  SELECT * INTO other FROM pg_temp.rules_fixture(2,9591);
  FOR n IN 1..27 LOOP
    v_trade:=gen_random_uuid(); ids:=array_append(ids,v_trade);
    INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status)
      VALUES(v_trade,CASE WHEN n=27 THEN other.league_id ELSE f.league_id END,
        CASE WHEN n=27 THEN other.season_id ELSE f.season_id END,
        CASE WHEN n=27 THEN other.member_ids[1] ELSE f.member_ids[1] END,
        CASE WHEN n=27 THEN other.member_ids[2] ELSE f.member_ids[2] END,
        CASE WHEN n%2=0 THEN 'pending' ELSE 'completed' END::public.trade_status);
    INSERT INTO public.trade_items(trade_id,from_member_id,to_member_id,faab_amount,side)
      VALUES(v_trade,CASE WHEN n=27 THEN other.member_ids[1] ELSE f.member_ids[1] END,
        CASE WHEN n=27 THEN other.member_ids[2] ELSE f.member_ids[2] END,10,'proposer');
  END LOOP;
  inputs:=public.get_trade_estimate_reanalysis_inputs(ids[1]);
  INSERT INTO public.trade_estimate_quotes(league_id,league_season_id,member_id,terms,inputs,analysis,model_version,input_version)
    VALUES(f.league_id,f.season_id,f.member_ids[1],inputs->'terms',inputs,analysis,'old-model','original-input') RETURNING trade_estimate_quotes.id INTO old_quote;
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(ids[1],old_quote);
  SELECT to_jsonb(q) INTO original FROM public.trade_estimate_quotes q WHERE q.id=old_quote;
  INSERT INTO public.trade_estimates(trade_id,unavailable_reason) VALUES(ids[2],'Original estimate unavailable');
  UPDATE public.leagues SET deleted_at=now() WHERE id=other.league_id;
  UPDATE public.league_seasons SET is_current=false WHERE id=other.season_id;
  PERFORM pg_temp.check_rules((SELECT count(*)<=25 AND count(*)>0 FROM public.get_trade_estimate_reanalysis_batch()),'work uses bounded nonempty batches');
  INSERT INTO private.work_items(kind,key,due_at,status,payload)
    VALUES('trade-estimate','onenumber-trade-curve-v5:'||(SELECT count(*) FROM public.trade_estimate_history WHERE formula_version='onenumber-trade-curve-v5'),now(),'dead',
      '{"reanalysisVersion":"onenumber-trade-curve-v5"}'::jsonb) ON CONFLICT(kind,key) DO UPDATE SET status='dead';
  PERFORM public.queue_trade_estimate_reanalysis();
  SELECT count(*) INTO before_count FROM private.work_items WHERE kind='trade-estimate' AND payload->>'reanalysisVersion'='onenumber-trade-curve-v5';
  PERFORM public.queue_trade_estimate_reanalysis();
  SELECT count(*) INTO after_count FROM private.work_items WHERE kind='trade-estimate' AND payload->>'reanalysisVersion'='onenumber-trade-curve-v5';
  PERFORM pg_temp.check_rules(before_count=after_count,'queue request is idempotent');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-estimate' AND status='pending'
    AND key='reanalysis:onenumber-trade-curve-v5:'||(SELECT count(*) FROM public.trade_estimate_history WHERE formula_version='onenumber-trade-curve-v5')),
    'new re-analysis work does not collide with retired pre-pick work');
  FOREACH v_trade IN ARRAY ids LOOP
    inputs:=public.get_trade_estimate_reanalysis_inputs(v_trade);
    new_quote:=public.save_trade_estimate_reanalysis(v_trade,inputs,analysis);
    retry_quote:=public.save_trade_estimate_reanalysis(v_trade,inputs,analysis);
    PERFORM pg_temp.check_rules(new_quote=retry_quote,'save replay preserves quote '||v_trade);
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=54 FROM public.trade_estimate_history WHERE trade_id=ANY(ids)),'every trade has both history records');
  PERFORM pg_temp.check_rules((SELECT h.snapshot->'quote'=original FROM public.trade_estimate_history h WHERE h.trade_id=ids[1] AND formula_version='original'),'original quote snapshot remains exact');
  PERFORM pg_temp.check_rules((SELECT snapshot->'estimate'->>'unavailable_reason'='Original estimate unavailable' FROM public.trade_estimate_history WHERE trade_id=ids[2] AND formula_version='original'),'original unavailable state remains exact');
  PERFORM pg_temp.check_rules((SELECT count(*)=27 FROM public.trade_estimates e JOIN public.trade_estimate_quotes q ON q.id=e.quote_id WHERE e.trade_id=ANY(ids) AND q.model_version='onenumber-trade-curve-v5'),'all saved estimates use the new formula');
  PERFORM pg_temp.check_rules(public.get_trade_estimate_reanalysis_inputs(ids[1]) IS NULL,'completed input request skips replay');
  PERFORM pg_temp.check_rules((SELECT NOT EXISTS(SELECT 1 FROM public.get_trade_estimate_reanalysis_batch() x WHERE x=ANY(ids))),'completed work leaves the batch');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.get_trade_estimate_reanalysis_inputs(uuid,text)','EXECUTE') AND NOT has_function_privilege('anon','public.save_trade_estimate_reanalysis(uuid,jsonb,jsonb,text)','EXECUTE'),'reanalysis RPCs stay service-only');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','public.trade_estimate_history','INSERT'),'history cannot be changed by clients');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO after_count FROM public.trade_estimate_history WHERE trade_id=ANY(ids);
  RESET ROLE;
  PERFORM pg_temp.check_rules(after_count=52,'history reads stay inside visible trade participants');
  UPDATE public.trade_estimate_quotes q SET expires_at=now()-interval '10 days' WHERE q.id IN(SELECT quote_id FROM public.trade_estimate_history WHERE trade_id=ANY(ids));
  PERFORM public.cleanup_trade_estimate_quotes();
  PERFORM private.retain_trade_estimate_quotes();
  PERFORM pg_temp.check_rules((SELECT count(*)=28 FROM public.trade_estimate_quotes q WHERE q.id IN(SELECT quote_id FROM public.trade_estimate_history WHERE trade_id=ANY(ids))),'both retention paths keep original and reanalysed quotes');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
