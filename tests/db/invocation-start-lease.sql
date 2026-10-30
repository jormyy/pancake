BEGIN;
\ir rules-support.sql
CREATE FUNCTION pg_temp.l4_prepare_invocation()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_key uuid:=gen_random_uuid(); v_work bigint; v_token uuid:=gen_random_uuid();
BEGIN
  INSERT INTO private.work_items(kind,key,payload,status,attempts,lease_token,lease_until,invocation_key)
  VALUES('sync-players',v_key::text,jsonb_build_object('benchmark',v_key),'running',1,v_token,clock_timestamp()+interval '5 minutes',v_key)
  RETURNING id INTO v_work;
  INSERT INTO public.edge_invocations(function_name,invocation_key,work_item_id,work_lease_token)
  VALUES('sync-players',v_key,v_work,v_token);
  PERFORM set_config('l4.invocation',v_key::text,true);
END;
$$;
DO $$
DECLARE invocation uuid; run uuid; item bigint; prior timestamptz;
BEGIN
  PERFORM pg_temp.l4_prepare_invocation();
  invocation:=current_setting('l4.invocation')::uuid;
  SELECT work_item_id INTO item FROM public.edge_invocations WHERE invocation_key=invocation;
  UPDATE private.work_items SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=item RETURNING lease_until INTO prior;
  run:=public.start_work_invocation(invocation,'sync-players');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.sync_runs WHERE id=run AND status='running'),'startup retains the watchdog run');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.edge_invocations WHERE invocation_key=invocation AND sync_run_id=run AND worker_status='running' AND worker_started_at IS NOT NULL),'startup retains invocation evidence');
  PERFORM pg_temp.check_rules((SELECT lease_until>prior+interval '4 minutes' FROM private.work_items WHERE id=item),'startup extends a nearly expired lease');
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',invocation,'sync-players'),'Invocation already started%','duplicate startup is rejected');
  PERFORM public.finish_edge_invocation(invocation,'success',7);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE id=item AND status='succeeded'),'finish completes the same work item');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.sync_runs WHERE id=run AND status='success' AND rows_affected=7),'finish retains success evidence');
  PERFORM public.finish_edge_invocation(invocation,'success',7);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.sync_runs WHERE id=run),'finish stays idempotent');

  PERFORM pg_temp.l4_prepare_invocation();invocation:=current_setting('l4.invocation')::uuid;
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',invocation,'wrong-function'),'Unknown invocation%','wrong function is rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',gen_random_uuid(),'sync-players'),'Unknown invocation%','unknown invocation is rejected');
  UPDATE public.edge_invocations SET queued_at=clock_timestamp()-interval '11 minutes' WHERE invocation_key=invocation;
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',invocation,'sync-players'),'Invocation expired%','expired startup is rejected');

  PERFORM pg_temp.l4_prepare_invocation();invocation:=current_setting('l4.invocation')::uuid;
  UPDATE private.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE invocation_key=invocation;
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',invocation,'sync-players'),'Work lease is no longer current','expired lease is rejected');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE invocation_key=invocation AND worker_started_at IS NOT NULL),'failed startup writes no running evidence');

  PERFORM pg_temp.l4_prepare_invocation();invocation:=current_setting('l4.invocation')::uuid;
  UPDATE private.work_items SET lease_token=gen_random_uuid() WHERE invocation_key=invocation;
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',invocation,'sync-players'),'Work lease is no longer current','replaced lease is rejected');

  PERFORM pg_temp.l4_prepare_invocation();invocation:=current_setting('l4.invocation')::uuid;
  UPDATE private.work_items SET status='succeeded',lease_until=NULL,lease_token=NULL WHERE invocation_key=invocation;
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',invocation,'sync-players'),'Work lease is no longer current','completed work is rejected');

  invocation:=gen_random_uuid();
  INSERT INTO public.edge_invocations(function_name,invocation_key) VALUES('sync-players',invocation);
  PERFORM pg_temp.reject_rules(format('SELECT public.start_work_invocation(%L,%L)',invocation,'sync-players'),'Invocation has no work lease','leased startup requires a work item');
  run:=public.start_edge_invocation(invocation,'sync-players');
  PERFORM public.finish_edge_invocation(invocation,'success');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.sync_runs WHERE id=run AND status='success'),'unleased invocation keeps its existing startup');
  PERFORM pg_temp.check_rules(has_function_privilege('service_role','public.start_work_invocation(uuid,text)','EXECUTE') AND NOT has_function_privilege('anon','public.start_work_invocation(uuid,text)','EXECUTE') AND NOT has_function_privilege('authenticated','public.start_work_invocation(uuid,text)','EXECUTE'),'startup stays service only');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
