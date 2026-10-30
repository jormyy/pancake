BEGIN;
\ir rules-support.sql
CREATE OR REPLACE FUNCTION pg_temp.l4_cron_history_fixture(p_expired integer,p_recent integer,p_active integer DEFAULT 0,p_at timestamptz DEFAULT '2031-01-02T00:00:00Z',p_command text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE backend_started timestamptz; history_command text:=p_command;
BEGIN
  SELECT backend_start INTO STRICT backend_started FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid();
  IF history_command IS NULL THEN SELECT command INTO STRICT history_command FROM cron.job WHERE jobname='work-dispatcher'; END IF;
  TRUNCATE cron.job_run_details;
  INSERT INTO cron.job_run_details(runid,jobid,job_pid,database,username,command,status,start_time,end_time)
    SELECT n,1,2147483000,current_database(),current_user,history_command,
      CASE WHEN n%11=0 THEN 'failed' ELSE 'succeeded' END,
      p_at-interval '2 days'-n*interval '1 second',p_at-interval '2 days'-n*interval '1 second'+interval '1 second'
    FROM generate_series(1,p_expired) n;
  INSERT INTO cron.job_run_details(runid,jobid,job_pid,database,username,command,status,start_time,end_time)
    SELECT p_expired+n,1,2147483000,current_database(),current_user,history_command,'succeeded',
      p_at-interval '12 hours'-n*interval '1 second',p_at-interval '12 hours'-n*interval '1 second'+interval '1 second'
    FROM generate_series(1,p_recent) n;
  INSERT INTO cron.job_run_details(runid,jobid,job_pid,database,username,command,status,start_time)
    SELECT p_expired+p_recent+n,1,pg_backend_pid(),current_database(),current_user,history_command,'running',backend_started FROM generate_series(1,p_active) n;
  ANALYZE cron.job_run_details;
  RETURN jsonb_build_object('expired',p_expired,'recent',p_recent,'active',p_active,'at',p_at);
END;
$$;
UPDATE private.work_items SET status='succeeded',due_at='2100-01-01',completed_at=now(),lease_token=NULL,lease_until=NULL;
DELETE FROM private.work_items WHERE kind='retention-prune';
SELECT pg_temp.l4_cron_history_fixture(1300,100,3);
UPDATE cron.job_run_details SET status='running',end_time=NULL WHERE runid=2;
UPDATE cron.job_run_details SET status='running',end_time=NULL,job_pid=pg_backend_pid(),
  start_time=(SELECT backend_start-interval '1 millisecond' FROM pg_stat_activity WHERE pid=pg_backend_pid()) WHERE runid=3;
UPDATE cron.job_run_details SET status='running',end_time=NULL,job_pid=pg_backend_pid(),
  start_time=(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()) WHERE runid=4;
UPDATE cron.job_run_details SET end_time='2031-01-01T00:00:00Z' WHERE runid=5;
UPDATE cron.job_run_details SET end_time=NULL,start_time=NULL WHERE runid=6;
UPDATE cron.job_run_details SET end_time=NULL WHERE runid=7;
UPDATE cron.job_run_details SET start_time='2030-01-01',end_time='2030-01-01' WHERE runid=1350;
CREATE TEMP TABLE expected_cron_history AS
  SELECT to_jsonb(r) AS row FROM cron.job_run_details r
  WHERE NOT COALESCE((r.status IN('succeeded','failed') AND COALESCE(r.end_time,r.start_time)<'2031-01-01T00:00:00Z')
    OR (r.status NOT IN('succeeded','failed') AND r.start_time<'2031-01-01T00:00:00Z'
      AND NOT EXISTS(SELECT 1 FROM pg_stat_activity active WHERE active.pid=r.job_pid AND active.backend_start<=r.start_time)),false);
DO $$
DECLARE removed integer; steps integer:=0;
BEGIN
  removed:=(private.retain_cron_job_run_details('2031-01-02T00:00:00Z')->>'cron.job_run_details')::integer;
  PERFORM pg_temp.check_rules(removed BETWEEN 1 AND 512,'one cron deletes at most 512 rows');
  LOOP
    removed:=(private.retain_cron_job_run_details('2031-01-02T00:00:00Z')->>'cron.job_run_details')::integer;
    EXIT WHEN removed=0;
    PERFORM pg_temp.check_rules(removed<=512,'later calls retain the delete cap '||steps);
    steps:=steps+1;
    IF steps>10 THEN RAISE EXCEPTION 'Cron history did not drain'; END IF;
  END LOOP;
  PERFORM pg_temp.check_rules(steps>0,'backlog drains through bounded calls');
  PERFORM pg_temp.check_rules(NOT EXISTS((SELECT row FROM expected_cron_history EXCEPT SELECT to_jsonb(r) FROM cron.job_run_details r)
    UNION ALL(SELECT to_jsonb(r) FROM cron.job_run_details r EXCEPT SELECT row FROM expected_cron_history)),'all retained rows match the original expiry and active-backend policy');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=4),'active old execution survives');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=3),'reused PID does not preserve an orphan');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=5),'expiry boundary is exclusive');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=6),'unknown timestamps survive');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=1350),'expiry does not assume timestamp order follows runid');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='retention-prune' AND invocation_key IS NOT NULL),'continuation creates no Edge invocation');
END;
$$;
DELETE FROM private.work_items WHERE kind='retention-prune';
SELECT pg_temp.l4_cron_history_fixture(0,0,1100);
INSERT INTO cron.job_run_details(runid,jobid,job_pid,database,username,command,status,start_time,end_time)
VALUES(1101,1,2147483000,current_database(),current_user,'SELECT 1','succeeded','2030-01-01','2030-01-01');
DO $$
DECLARE removed integer;
BEGIN
  PERFORM private.retain_cron_job_run_details('2031-01-02T00:00:00Z');
  FOR i IN 1..5 LOOP
    removed:=(private.retain_cron_job_run_details('2031-01-02T00:00:00Z')->>'cron.job_run_details')::integer;
    EXIT WHEN removed=0;
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=1100 AND max(runid)=1100 FROM cron.job_run_details),'a large active prefix does not block expiry later in runid order');
END;
$$;
SELECT pg_temp.check_rules((SELECT retention_rule LIKE '%512 rows per batch%' FROM private.retention_rules WHERE relation_name='cron.job_run_details'),'retention dashboard reports the installed batch cap');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
