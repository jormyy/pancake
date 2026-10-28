BEGIN;
\ir rules-support.sql
DO $$
DECLARE request uuid; retry_id bigint; started timestamptz; sync_date date;
  work_id bigint; invocation uuid:=gen_random_uuid(); token uuid:=gen_random_uuid(); run_id uuid;
BEGIN
  DELETE FROM private.work_items WHERE kind='sync-trade-values';
  UPDATE private.trade_value_sync_state SET request_id=NULL,last_request_at=NULL,fetched_at=clock_timestamp()-interval '1 day' WHERE id;
  sync_date:=(clock_timestamp() AT TIME ZONE 'America/New_York')::date;
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.fail_trade_value_sync(uuid,integer,date,boolean)','EXECUTE'),'anonymous users cannot schedule retries');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.fail_trade_value_sync(uuid,integer,date,boolean)','EXECUTE'),'members cannot schedule retries');
  PERFORM pg_temp.check_rules(has_function_privilege('service_role','public.fail_trade_value_sync(uuid,integer,date,boolean)','EXECUTE'),'the service role can schedule retries');
  FOR retry IN 0..4 LOOP
    request:=gen_random_uuid();
    PERFORM pg_temp.check_rules(public.claim_trade_value_sync(request),'a failed fetch does not consume the daily claim '||retry);
    PERFORM pg_temp.check_rules(NOT public.claim_trade_value_sync(gen_random_uuid()),'an active claim excludes another worker '||retry);
    started:=clock_timestamp();
    retry_id:=public.fail_trade_value_sync(request,retry,sync_date,true);
    IF retry<4 THEN
      PERFORM pg_temp.check_rules(retry_id IS NOT NULL,'each of the first four failures schedules a retry '||retry);
      PERFORM pg_temp.check_rules((SELECT key='sync-trade-values-retry-'||(retry+1)||'-'||sync_date
        AND payload=jsonb_build_object('retry',retry+1,'retryDate',sync_date)
        AND due_at BETWEEN started+interval '30 minutes' AND clock_timestamp()+interval '30 minutes'
        AND status='pending' FROM private.work_items WHERE id=retry_id),'the retry has the exact key, payload, and thirty-minute delay '||retry);
    ELSE
      PERFORM pg_temp.check_rules(retry_id IS NULL,'the fifth failure schedules nothing '||retry);
    END IF;
    PERFORM pg_temp.check_rules(public.fail_trade_value_sync(request,retry,sync_date,true) IS NULL,'duplicate failure callbacks cannot enqueue another retry '||retry);
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM private.work_items WHERE kind='sync-trade-values'),'the day contains exactly four retries');
  request:=gen_random_uuid();
  PERFORM public.claim_trade_value_sync(request);
  PERFORM pg_temp.check_rules(public.fail_trade_value_sync(gen_random_uuid(),0,sync_date,true) IS NULL,'a stale worker cannot release another claim');
  PERFORM pg_temp.check_rules((SELECT request_id=request FROM private.trade_value_sync_state WHERE id),'a stale failure preserves the active claim');
  PERFORM public.fail_trade_value_sync(request,0,sync_date,false);
  PERFORM pg_temp.check_rules((SELECT request_id IS NULL FROM private.trade_value_sync_state WHERE id),'a contract failure releases its claim');
  request:=gen_random_uuid();
  PERFORM public.claim_trade_value_sync(request);
  UPDATE private.trade_value_sync_state SET fetched_at=clock_timestamp() WHERE id;
  PERFORM pg_temp.check_rules(public.fail_trade_value_sync(request,0,sync_date,true) IS NULL,'failure callbacks cannot undo a published snapshot');
  PERFORM pg_temp.check_rules(NOT public.claim_trade_value_sync(gen_random_uuid()),'a successful snapshot blocks another live sync that day');
  UPDATE private.trade_value_sync_state SET fetched_at=clock_timestamp()-interval '1 day',last_request_at=clock_timestamp()-interval '4 minutes' WHERE id;
  PERFORM pg_temp.check_rules(public.claim_trade_value_sync(gen_random_uuid()),'an abandoned claim expires after three minutes');
  UPDATE private.trade_value_sync_state SET request_id=NULL WHERE id;
  INSERT INTO private.work_items(kind,key,due_at,status,attempts,lease_token,lease_until,invocation_key)
    VALUES('sync-trade-values','retry-error-bookkeeping',now(),'running',1,token,now()+interval '5 minutes',invocation) RETURNING id INTO work_id;
  INSERT INTO public.edge_invocations(invocation_key,function_name,work_item_id,work_lease_token)
    VALUES(invocation,'sync-trade-values',work_id,token);
  run_id:=public.start_edge_invocation(invocation,'sync-trade-values');
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-work-key',invocation)::text,true);
  request:=gen_random_uuid();
  PERFORM public.claim_trade_value_sync(request);
  PERFORM public.fail_trade_value_sync(request,4,sync_date,true);
  PERFORM set_config('request.headers','{}',true);
  PERFORM public.finish_edge_invocation(invocation,'failed',NULL,'OneNumberHoops /api/players fetch failed: Signal timed out');
  PERFORM pg_temp.check_rules((SELECT status='dead' AND last_error LIKE '%fetch failed: Signal timed out' FROM private.work_items WHERE id=work_id),'the failed work item preserves the fetch error and bypasses short queue retries');
  PERFORM pg_temp.check_rules((SELECT status='failed' AND error LIKE '%fetch failed: Signal timed out' FROM public.sync_runs WHERE id=run_id),'the sync run preserves the fetch failure');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
