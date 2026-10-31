BEGIN;
SET LOCAL statement_timeout='60s';
SELECT set_config('app.supabase_url','http://127.0.0.1:1',true);
SELECT set_config('app.edge_internal_token','local-database-ci-token',true);
CREATE TEMP TABLE stalled_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_stalled(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO stalled_checks VALUES(label);
END;
$$;
CREATE FUNCTION pg_temp.claim_poll(p_key text) RETURNS private.work_items LANGUAGE plpgsql AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  DELETE FROM private.work_items;
  DELETE FROM public.live_poll_leases;
  PERFORM private.work_enqueue('live-poll',p_key,now());
  SELECT * INTO STRICT v_item FROM private.work_claim(1);
  PERFORM private.work_execute(v_item.id,v_item.lease_token);
  SELECT * INTO STRICT v_item FROM private.work_items WHERE id=v_item.id;
  RETURN v_item;
END;
$$;
CREATE FUNCTION pg_temp.queued_ago(p_item private.work_items,p_age interval) RETURNS void LANGUAGE sql AS $$
  UPDATE public.edge_invocations SET queued_at=clock_timestamp()-p_age WHERE invocation_key=p_item.invocation_key;
$$;
CREATE FUNCTION pg_temp.respond(p_item private.work_items,p_status integer,p_timed_out boolean,p_error text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO net._http_response(id,status_code,timed_out,error_msg,created)
  SELECT request_id,p_status,p_timed_out,p_error,clock_timestamp() FROM public.edge_invocations WHERE invocation_key=p_item.invocation_key;
$$;
CREATE FUNCTION pg_temp.start_code(p_key uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.start_work_invocation(p_key,'live-poll');
  RETURN 'started';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END;
$$;
CREATE FUNCTION pg_temp.finish_code(p_key uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.finish_edge_invocation(p_key,'success');
  RETURN 'finished';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END;
$$;
DO $$
DECLARE
  v_item private.work_items%ROWTYPE; v_retry private.work_items%ROWTYPE; v_old_key uuid; v_id bigint;
  v_worker_error constant text:='Timeout of 30000 ms reached. Total time: 30001.612000 ms (DNS time: 30001.612000 ms)';
BEGIN
  v_item:=pg_temp.claim_poll('timeout-no-worker');
  PERFORM pg_temp.queued_ago(v_item,interval '31 seconds');
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=0,'no response yet leaves a fresh request alone');
  PERFORM pg_temp.respond(v_item,NULL,false,v_worker_error);
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=1,'transport timeout with no worker is released');
  v_old_key:=v_item.invocation_key;
  SELECT * INTO v_retry FROM private.work_items WHERE id=v_item.id;
  PERFORM pg_temp.check_stalled(v_retry.status='failed' AND v_retry.due_at<=now() AND v_retry.attempts=1 AND v_retry.lease_token IS NULL AND v_retry.last_error='Worker never started','released item is due now and keeps its attempt');
  PERFORM pg_temp.check_stalled(pg_temp.start_code(v_old_key)='PT409','a late worker cannot start after release');
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=0,'release is idempotent');
  SELECT * INTO STRICT v_retry FROM private.work_claim(1);
  PERFORM pg_temp.check_stalled(v_retry.id=v_item.id AND v_retry.attempts=2,'released item is claimed again without a backoff');
  PERFORM private.work_execute(v_retry.id,v_retry.lease_token);
  SELECT * INTO v_retry FROM private.work_items WHERE id=v_item.id;
  PERFORM pg_temp.check_stalled(pg_temp.start_code(v_old_key)='PT409','the first worker stays fenced during the retry');
  PERFORM pg_temp.check_stalled(pg_temp.start_code(v_retry.invocation_key)='started','the retry worker starts');
  PERFORM pg_temp.check_stalled((SELECT count(*) FROM public.edge_invocations WHERE work_item_id=v_item.id AND worker_started_at IS NOT NULL)=1,'one worker only across both invocations');
  PERFORM pg_temp.check_stalled(pg_temp.finish_code(v_retry.invocation_key)='finished','the retry worker finishes');
  PERFORM pg_temp.check_stalled((SELECT status FROM private.work_items WHERE id=v_item.id)='succeeded','the retry settles the item');

  v_item:=pg_temp.claim_poll('timeout-with-worker');
  PERFORM pg_temp.check_stalled(pg_temp.start_code(v_item.invocation_key)='started','normal worker starts');
  PERFORM pg_temp.queued_ago(v_item,interval '100 seconds');
  PERFORM pg_temp.respond(v_item,NULL,true,v_worker_error);
  INSERT INTO public.live_poll_leases(lock_key,holder_id,expires_at) VALUES(779001,gen_random_uuid(),clock_timestamp()+interval '90 seconds');
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=0,'transport wait with a running worker is not retried');
  PERFORM pg_temp.check_stalled((SELECT status FROM private.work_items WHERE id=v_item.id)='running','the running worker keeps its lease');
  PERFORM pg_temp.check_stalled(pg_temp.finish_code(v_item.invocation_key)='finished','the running worker finishes normally');
  PERFORM pg_temp.check_stalled((SELECT status FROM private.work_items WHERE id=v_item.id)='succeeded','normal transport wait counts as success');
  PERFORM pg_temp.check_stalled((SELECT attempts FROM private.work_items WHERE id=v_item.id)=1,'normal transport wait uses one attempt');

  v_item:=pg_temp.claim_poll('accepted-no-worker');
  PERFORM pg_temp.queued_ago(v_item,interval '119 seconds');
  PERFORM pg_temp.respond(v_item,200,false,NULL);
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=0,'an accepted request waits for its worker');
  PERFORM pg_temp.queued_ago(v_item,interval '120 seconds');
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=1,'two minutes without a worker is released');

  v_item:=pg_temp.claim_poll('http-500-no-worker');
  PERFORM pg_temp.queued_ago(v_item,interval '20 seconds');
  PERFORM pg_temp.respond(v_item,500,false,NULL);
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=1,'a failed response with no worker is released');

  v_item:=pg_temp.claim_poll('silent-worker');
  PERFORM pg_temp.check_stalled(pg_temp.start_code(v_item.invocation_key)='started','silent worker starts');
  UPDATE private.work_items SET lease_until=clock_timestamp()+interval '211 seconds' WHERE id=v_item.id;
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=0,'a recent heartbeat keeps the lease without a live holder');
  UPDATE private.work_items SET lease_until=clock_timestamp()+interval '209 seconds' WHERE id=v_item.id;
  INSERT INTO public.live_poll_leases(lock_key,holder_id,expires_at) VALUES(779001,gen_random_uuid(),clock_timestamp()+interval '30 seconds');
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=0,'a live holder keeps the lease despite a late heartbeat');
  UPDATE public.live_poll_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lock_key=779001;
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=1,'a silent worker with no live holder is released');
  PERFORM pg_temp.check_stalled((SELECT last_error FROM private.work_items WHERE id=v_item.id)='Worker stopped renewing its lease','the release names the silent worker');
  PERFORM pg_temp.check_stalled(pg_temp.finish_code(v_item.invocation_key)='PT409','a released worker cannot settle the retried item');
  PERFORM pg_temp.check_stalled(public.renew_work_lease(v_item.invocation_key)=false,'a released worker loses its heartbeat');

  v_item:=pg_temp.claim_poll('third-attempt');
  UPDATE private.work_items SET attempts=3 WHERE id=v_item.id;
  PERFORM pg_temp.queued_ago(v_item,interval '2 minutes');
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=1,'the third failed delivery is released');
  PERFORM pg_temp.check_stalled((SELECT status FROM private.work_items WHERE id=v_item.id)='dead','attempt limits still apply');

  DELETE FROM private.work_items;
  PERFORM private.work_enqueue('refresh-views','other-kind',now());
  SELECT * INTO STRICT v_item FROM private.work_claim(1);
  PERFORM private.work_execute(v_item.id,v_item.lease_token);
  SELECT * INTO v_item FROM private.work_items WHERE id=v_item.id;
  PERFORM pg_temp.queued_ago(v_item,interval '3 minutes');
  PERFORM pg_temp.check_stalled(private.release_stalled_live_poll()=0,'other kinds keep the lease path');

  v_item:=pg_temp.claim_poll('through-dispatch');
  v_old_key:=v_item.invocation_key;
  v_id:=v_item.id;
  PERFORM pg_temp.queued_ago(v_item,interval '60 seconds');
  PERFORM pg_temp.respond(v_item,NULL,false,v_worker_error);
  UPDATE private.worker_controls SET paused=false WHERE id;
  PERFORM public.dispatch_work();
  SELECT * INTO v_retry FROM private.work_items WHERE id=v_id;
  PERFORM pg_temp.check_stalled(v_retry.status='running' AND v_retry.attempts=2 AND v_retry.invocation_key IS DISTINCT FROM v_old_key,'the dispatcher retries on its next minute');
  PERFORM pg_temp.check_stalled((SELECT count(*) FROM public.edge_invocations WHERE work_item_id=v_id)=2,'the retry is a second invocation');
  PERFORM pg_temp.check_stalled(pg_temp.start_code(v_old_key)='PT409','the dispatcher retry fences the first worker');
END;
$$;
SELECT count(*) AS stalled_checks FROM stalled_checks;
ROLLBACK;
