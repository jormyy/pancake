BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT pg_get_functiondef('private.work_claim(integer)'::regprocedure);
SELECT kind,function_name,retired_at FROM private.work_kinds
  WHERE kind IN('trade-revaluation-check','trade-revaluation-scan','trade-revaluation','notification-scan','forecast-inputs','matchup-forecasts');
SELECT id,kind,encode(convert_to(kind,'UTF8'),'hex') AS kind_bytes,status,due_at,attempts,created_at,
  lease_until,last_error FROM private.work_items
  WHERE id IN(7285,7286,7287,7288,7289,7377,7415,7417,7436,7473,7501,7514,7519,7523,7378,7526,6347)
  ORDER BY due_at,id;
SELECT id,kind,status,due_at,attempts,created_at,completed_at FROM private.work_items
  WHERE kind='trade-revaluation-check' AND status='succeeded' AND completed_at>now()-interval '3 hours'
  ORDER BY completed_at DESC LIMIT 20;
SELECT DISTINCT a.pid,a.state,a.xact_start,a.backend_start,a.wait_event_type,a.wait_event,
  l.mode,l.granted,pg_blocking_pids(a.pid) AS blockers
  FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
  WHERE l.relation='private.work_items'::regclass AND a.pid<>pg_backend_pid()
  ORDER BY a.xact_start,a.pid;
SELECT pid,state,xact_start,backend_start,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
  FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'
    AND pid<>pg_backend_pid() ORDER BY xact_start;
ROLLBACK;
