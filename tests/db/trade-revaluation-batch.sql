BEGIN;
\ir rules-support.sql
\ir perf-l4-trade-batch-fixture.sql
SELECT pg_temp.l4_batch_fixture(25,false);
DO $$
DECLARE f record; v_result jsonb; v_trade uuid; v_fingerprint text; v_count integer;
BEGIN
  SELECT * INTO f FROM l4_batch_context;
  PERFORM pg_temp.check_rules((SELECT count(*)=25 AND bool_and(input.input_version=private.trade_revaluation_input_version(input.trade_id))
    FROM private.trade_revaluation_input_versions(f.league_id) input),'batch fingerprints equal individual fingerprints');
  v_result:=private.refresh_queue_trade_revaluations(f.season_id,1,'batch-fixture');
  PERFORM pg_temp.check_rules(v_result='{"queued":25}','one scan queues every changed open trade');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-check'),
    'the scan creates no per-trade check invocations');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-scan'),
    'more than twenty trades need no continuation scan');
  PERFORM pg_temp.check_rules((SELECT bool_and(payload->>'inputFingerprint'=private.trade_revaluation_input_version((payload->>'tradeId')::uuid))
    FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation'),'queued fingerprints match current inputs');
  INSERT INTO public.trade_value_cache(trade_id,league_id,league_season_id,revaluation,valid_until,version)
    SELECT unnest(f.trade_ids),f.league_id,f.season_id,'{}','infinity',0;
  INSERT INTO private.trade_value_publications(trade_id,version,valid_until,input_fingerprint,model_version)
    SELECT input.trade_id,0,now()-interval '1 hour',input.input_version,'batch-fixture' FROM private.trade_revaluation_input_versions(f.league_id) input;
  UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(private.refresh_queue_trade_revaluations(f.season_id,2,'batch-fixture')='{"queued":0}',
    'unchanged fingerprints skip revaluation');
  PERFORM pg_temp.check_rules((SELECT bool_and(published.version=queued.version AND published.valid_until='infinity')
    FROM private.trade_value_publications published JOIN public.trades trade ON trade.id=published.trade_id
    JOIN private.screen_refresh_queue queued ON queued.league_season_id=trade.league_season_id WHERE trade.league_id=f.league_id),
    'unchanged values advance freshness without recomputing');
  PERFORM pg_temp.check_rules(private.refresh_queue_trade_revaluations(f.season_id,2,'changed-model')='{"queued":25}',
    'a changed model requeues open trades');
  v_trade:=f.trade_ids[1];
  v_fingerprint:=private.trade_revaluation_input_version(v_trade);
  UPDATE public.trade_items SET faab_amount=faab_amount+1 WHERE trade_id=v_trade AND faab_amount>0;
  PERFORM pg_temp.check_rules(v_fingerprint<>private.trade_revaluation_input_version(v_trade),'changed FAAB assets change the fingerprint');
  PERFORM pg_temp.check_rules(private.refresh_queue_trade_revaluations(f.season_id,3,'batch-fixture')='{"queued":1}',
    'only the changed trade is requeued');
  UPDATE public.league_members SET team_name=team_name||' changed' WHERE id=f.member_ids[2];
  PERFORM pg_temp.check_rules((SELECT bool_and(input.input_version=private.trade_revaluation_input_version(input.trade_id))
    FROM private.trade_revaluation_input_versions(f.league_id) input),'pick owner labels preserve fingerprint parity');
  INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance) VALUES(f.league_id,f.season_id,f.member_ids[1],27) ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=EXCLUDED.balance;
  PERFORM pg_temp.check_rules((SELECT bool_and(input.input_version=private.trade_revaluation_input_version(input.trade_id))
    FROM private.trade_revaluation_input_versions(f.league_id) input),'explicit FAAB balances preserve fingerprint parity');
  UPDATE public.leagues SET scoring_settings='{"points":2}' WHERE id=f.league_id;
  PERFORM pg_temp.check_rules((SELECT bool_and(input.input_version=private.trade_revaluation_input_version(input.trade_id))
    FROM private.trade_revaluation_input_versions(f.league_id) input),'scoring changes preserve fingerprint parity');
  UPDATE public.trades SET status='completed' WHERE id=v_trade;
  PERFORM pg_temp.check_rules((SELECT count(*)=24 FROM private.trade_revaluation_input_versions(f.league_id)),
    'closed trades are excluded');
  SELECT id INTO v_trade FROM public.trades WHERE league_id=f.league_id ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.check_rules(private.refresh_queue_trade_revaluations(f.season_id,4,'after-fixture',v_trade)='{"queued":0}',
    'old continuation cursors remain compatible');
  PERFORM pg_temp.check_rules(private.refresh_queue_trade_revaluations(gen_random_uuid(),4,'fixture')='{"queued":0}',
    'missing seasons create no work');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.trade_revaluation_input_versions(uuid)','EXECUTE')
    AND NOT has_function_privilege('service_role','private.trade_revaluation_input_versions(uuid)','EXECUTE'),
    'only the private refresh entrypoint can execute the bulk helper');
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
