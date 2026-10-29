SET pg_stat_statements.track='none';
SET auto_explain.log_min_duration=-1;
INSERT INTO private.work_items(kind,key,status,due_at,completed_at,payload)
SELECT 'sync-players','l3e-history-'||n,'succeeded','2026-10-28T12:00:00Z'::timestamptz-interval '1 minute'*n,
  '2026-10-28T12:00:01Z'::timestamptz-interval '1 minute'*n,'{}'::jsonb
FROM generate_series(1,3756) n;
INSERT INTO cron.job_run_details(jobid,runid,job_pid,database,username,command,status,start_time,end_time,return_message)
SELECT 1,n,0,'postgres','postgres','SELECT public.dispatch_work()',
  CASE WHEN n%100=0 THEN 'failed' ELSE 'succeeded' END,
  '2026-10-28T12:00:00Z'::timestamptz-interval '20 seconds'*n,
  '2026-10-28T12:00:01Z'::timestamptz-interval '20 seconds'*n,'1 row'
FROM generate_series(1,3215) n;
ANALYZE private.work_items;
ANALYZE cron.job_run_details;
