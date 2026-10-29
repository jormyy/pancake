BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
DO $$
DECLARE
  f record; v_item private.work_items%ROWTYPE; v_request uuid:=gen_random_uuid(); v_boundary uuid:=gen_random_uuid();
  v_old_work bigint; v_boundary_work bigint; v_dead_work bigint; v_at timestamptz:=now(); v_count bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9961);
  PERFORM private.enqueue_scheduled_work('2004-06-21 09:59:59 UTC');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='retention-prune'),'retention waits for ten UTC');
  PERFORM private.enqueue_scheduled_work('2004-06-21 10:17 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='retention-prune'),'Monday retention catches up after ten UTC');
  PERFORM private.enqueue_scheduled_work('2004-06-21 23:59 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='retention-prune'),'repeat daily ticks keep one retention item');
  DELETE FROM private.work_items WHERE kind<>'retention-prune';
  UPDATE private.work_items SET due_at=v_at WHERE kind='retention-prune';
  INSERT INTO private.request_receipts(request_id,actor,function,result,input_hash,created_at)
    VALUES(v_request,f.user_ids[1],'fixture','{}','fixture',v_at-interval '8 days'),
      (v_boundary,f.user_ids[1],'fixture','{}','fixture',v_at-interval '7 days');
  INSERT INTO public.perf_beacons(member_id,screen,useful_ms,request_count,transfer_bytes,bytes_complete,cold,
    device_class,connection_type,app_version,sample_n,received_at)
    VALUES(f.member_ids[1],'roster',1,1,1,true,false,'desktop','unknown','fixture',1,v_at-interval '31 days'),
      (f.member_ids[1],'roster',1,1,1,true,false,'desktop','unknown','fixture',1,v_at-interval '30 days');
  INSERT INTO private.work_items(kind,key,status,completed_at)
    VALUES('player-stats-hints','retention-old-success','succeeded',v_at-interval '8 days') RETURNING id INTO v_old_work;
  INSERT INTO private.work_items(kind,key,status,completed_at)
    VALUES('player-stats-hints','retention-boundary-success','succeeded',v_at-interval '7 days') RETURNING id INTO v_boundary_work;
  INSERT INTO private.work_items(kind,key,status,completed_at,attempts)
    VALUES('player-stats-hints','retention-boundary-dead','dead',v_at-interval '90 days',3) RETURNING id INTO v_dead_work;
  SELECT * INTO STRICT v_item FROM private.work_claim(1);
  PERFORM private.work_execute(v_item.id,v_item.lease_token);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM private.work_items WHERE id=v_item.id),'dispatcher completes the retention work item');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.request_receipts WHERE request_id=v_request)
    AND EXISTS(SELECT 1 FROM private.request_receipts WHERE request_id=v_boundary),'queue retention preserves request receipt expiry and its boundary');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND min(received_at)=v_at-interval '30 days' FROM public.perf_beacons WHERE member_id=f.member_ids[1]),
    'queue retention preserves beacon expiry and its boundary');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE id=v_old_work)
    AND (SELECT count(*)=2 FROM private.work_items WHERE id IN(v_boundary_work,v_dead_work)),'successful work expires while cutoff and dead evidence stay');
  PERFORM pg_temp.check_rules((SELECT count(*)=3 AND sum(rows_pruned)=3 FROM private.retention_status
    WHERE relation_name IN ('private.request_receipts','public.perf_beacons','private.work_items')),'imported cleanup keeps exact prune summaries');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events
    WHERE kind='work.succeeded' AND detail->>'work_id'=v_item.id::text),'retention keeps the queue completion event');
  PERFORM private.enqueue_scheduled_work('2004-06-22 10:01 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='retention-prune'),'next UTC day gets a new retention item');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(jobname='work-dispatcher') FROM cron.job WHERE jobname NOT IN ('io-hint-drain','io-cron-history-retention','public-read-retention')),'retention and views share the sole dispatcher cron entry');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
