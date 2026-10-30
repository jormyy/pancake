BEGIN;
\ir rules-support.sql
CREATE OR REPLACE FUNCTION pg_temp.l4_reconcile_fixture(p_repetitions integer DEFAULT 20)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_label text; n bigint:=0; v_run uuid; v_queued timestamptz; v_started timestamptz; v_finished timestamptz; v_status text; v_response integer; v_key uuid; v_id bigint;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS l4_reconcile_ids(id bigint PRIMARY KEY,label text);
  TRUNCATE l4_reconcile_ids;
  FOR i IN 1..p_repetitions LOOP
    FOREACH v_label IN ARRAY ARRAY['finished-success','finished-failed','timeout','active','key-http500','vanished-key',
      'legacy-timeout','legacy-http500','injury404','legacy-fresh','unstarted-ok'] LOOP
      n:=n+1;v_run:=NULL;v_started:=NULL;v_finished:=NULL;v_status:='pending';v_response:=NULL;v_key:=gen_random_uuid();v_queued:=now()-interval '5 minutes';
      IF v_label LIKE 'legacy-%' OR v_label='injury404' THEN v_key:=NULL; END IF;
      IF v_label='legacy-timeout' THEN v_queued:=now()-interval '3 hours'; END IF;
      IF v_label='vanished-key' THEN v_queued:=now()-interval '11 minutes'; END IF;
      IF v_label IN('finished-success','finished-failed','timeout','active') THEN
        v_started:=now()-interval '4 minutes';v_status:='running';v_response:=200;
        IF v_label LIKE 'finished-%' THEN v_finished:=now()-interval '3 minutes';v_status:=CASE WHEN v_label='finished-success' THEN 'success' ELSE 'failed' END; END IF;
        IF v_label='timeout' THEN v_queued:=now()-interval '20 minutes';v_started:=now()-interval '11 minutes'; END IF;
        INSERT INTO public.sync_runs(function_name,started_at,finished_at,status,error)
          VALUES('l4-reconcile-'||v_label,v_started,v_finished,v_status,CASE WHEN v_status='failed' THEN 'worker error' END) RETURNING sync_runs.id INTO v_run;
      END IF;
      IF v_label IN('finished-failed','key-http500','legacy-http500') THEN v_response:=500; END IF;
      IF v_label='injury404' THEN v_response:=404; END IF;
      IF v_label='unstarted-ok' THEN v_response:=200; END IF;
      INSERT INTO public.edge_invocations(function_name,request_id,queued_at,invocation_key,worker_started_at,worker_finished_at,worker_status,sync_run_id)
        VALUES(CASE WHEN v_label='injury404' THEN 'sync-player-injuries' ELSE 'l4-reconcile-'||v_label END,
          990088000000+n,v_queued,v_key,v_started,v_finished,v_status,v_run) RETURNING edge_invocations.id INTO v_id;
      INSERT INTO l4_reconcile_ids VALUES(v_id,v_label);
      IF v_response IS NOT NULL THEN
        INSERT INTO net._http_response(id,status_code,content,timed_out,created)
          VALUES(990088000000+n,v_response,CASE WHEN v_response>=400 THEN '{"error":"fixture"}' ELSE '{"ok":true}' END,false,now());
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
UPDATE public.edge_invocations SET reconciled_at=now() WHERE reconciled_at IS NULL;
SELECT pg_temp.l4_reconcile_fixture(1);
SELECT pg_temp.check_rules(private.reconcile_edge_invocations()=8,'eight terminal cases reconcile');
SELECT pg_temp.check_rules(private.reconcile_edge_invocations()=0,'reconciliation is idempotent during the grace windows');
DO $$
DECLARE v_inv record;
BEGIN
  FOR v_inv IN SELECT inv.*,fixture.label FROM public.edge_invocations inv JOIN l4_reconcile_ids fixture USING(id) LOOP
    IF v_inv.label IN('active','key-http500','legacy-fresh') THEN
      PERFORM pg_temp.check_rules(v_inv.reconciled_at IS NULL,v_inv.label||' retains its grace window');
    ELSE
      PERFORM pg_temp.check_rules(v_inv.reconciled_at IS NOT NULL,v_inv.label||' settles');
    END IF;
    IF v_inv.label='timeout' THEN
      PERFORM pg_temp.check_rules(v_inv.worker_status='failed' AND EXISTS(SELECT 1 FROM public.sync_runs WHERE id=v_inv.sync_run_id
        AND status='failed' AND error='worker did not finish within 10 minutes'),'worker timeout keeps failure evidence');
    ELSIF v_inv.label='active' THEN
      PERFORM pg_temp.check_rules(v_inv.worker_status='running' AND v_inv.status_code=200,'running workers retain transport evidence');
    ELSIF v_inv.label='key-http500' THEN
      PERFORM pg_temp.check_rules(v_inv.status_code=500 AND v_inv.error_message LIKE 'HTTP 500:%' AND v_inv.sync_run_id IS NULL,'young keyed HTTP failure keeps transport evidence without a premature run');
    ELSIF v_inv.label IN('vanished-key','legacy-timeout','legacy-http500') THEN
      PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.sync_runs WHERE id=v_inv.sync_run_id AND status='failed'),v_inv.label||' keeps a durable failure run');
    ELSIF v_inv.label='injury404' THEN
      PERFORM pg_temp.check_rules(v_inv.status_code=404 AND v_inv.sync_run_id IS NULL,'missing retired injury endpoint stays tolerated');
    ELSIF v_inv.label='finished-failed' THEN
      PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.sync_runs WHERE id=v_inv.sync_run_id AND status='failed' AND error='worker error'),'finished worker error is preserved');
    END IF;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
