BEGIN;
\ir rules-support.sql
DO $$
DECLARE period text:=gen_random_uuid()::text; invocation bigint; request bigint:=990009235; claimed timestamptz;
BEGIN
  DELETE FROM cron_dispatch_state WHERE job_key='et:player-injuries';
  PERFORM private.claim_cron_dispatch('et:player-injuries',period);
  SELECT dispatched_at INTO claimed FROM cron_dispatch_state WHERE job_key='et:player-injuries';
  INSERT INTO edge_invocations(function_name,request_id,queued_at,dispatch_job_key,dispatch_period_key,dispatch_claimed_at,invocation_key)
    VALUES('sync-player-injuries',request,now()-interval '11 minutes','et:player-injuries',period,claimed,gen_random_uuid()) RETURNING id INTO invocation;
  INSERT INTO net._http_response(id,status_code,content,created) VALUES(request,404,'Function not found',now());
  PERFORM private.reconcile_edge_invocations();
  PERFORM pg_temp.check_rules((SELECT status_code=404 AND reconciled_at IS NOT NULL AND error_message LIKE 'HTTP 404%' AND sync_run_id IS NULL FROM edge_invocations WHERE id=invocation),'missing injury function records its 404 without a failed sync run');
  PERFORM pg_temp.check_rules((SELECT retry_after IS NULL AND attempts=1 FROM cron_dispatch_state WHERE job_key='et:player-injuries'),'missing injury function never schedules a retry');
  PERFORM pg_temp.check_rules(NOT private.claim_cron_dispatch('et:player-injuries',period),'the same injury bucket cannot dispatch again');
  PERFORM private.reconcile_edge_invocations();
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM edge_invocations WHERE dispatch_job_key='et:player-injuries' AND dispatch_period_key=period),'reconcile keeps one record per bucket');
  PERFORM pg_temp.check_rules(private.claim_cron_dispatch('et:player-injuries',period||':next'),'the next injury bucket remains available');
  SELECT dispatched_at INTO claimed FROM cron_dispatch_state WHERE job_key='et:player-injuries';
  INSERT INTO edge_invocations(function_name,request_id,queued_at,dispatch_job_key,dispatch_period_key,dispatch_claimed_at,invocation_key)
    VALUES('sync-player-injuries',request+1,now()-interval '11 minutes','et:player-injuries',period||':next',claimed,gen_random_uuid()) RETURNING id INTO invocation;
  INSERT INTO net._http_response(id,status_code,content,created) VALUES(request+1,500,'Worker failed',now());
  PERFORM private.reconcile_edge_invocations();
  PERFORM pg_temp.check_rules((SELECT status='failed' FROM sync_runs WHERE id=(SELECT sync_run_id FROM edge_invocations WHERE id=invocation)),'injury worker errors still create failed sync runs');
  PERFORM pg_temp.check_rules((SELECT retry_after IS NOT NULL FROM cron_dispatch_state WHERE job_key='et:player-injuries'),'injury worker errors still schedule retries');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
