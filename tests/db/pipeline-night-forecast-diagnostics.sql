SELECT count(*) FILTER(WHERE q.dirty) AS dirty,
  count(*) FILTER(WHERE q.dirty AND q.available_at<=now()) AS dirty_due,
  count(*) FILTER(WHERE q.dirty AND q.available_at<=now() AND private.matchup_forecast_refresh_pending(q.matchup_id)) AS dirty_due_blocked,
  count(*) FILTER(WHERE q.dirty AND q.available_at<=now() AND NOT private.matchup_forecast_refresh_pending(q.matchup_id)
    AND (q.claimed_at IS NULL OR q.claimed_at<now()-interval '3 minutes')) AS claimable,
  count(*) FILTER(WHERE q.dirty AND q.last_error IS NOT NULL) AS errors,
  count(*) FILTER(WHERE q.dirty AND q.input_fingerprint->>'inputs'=q.computed_fingerprint->>'inputs') AS dirty_with_unchanged_inputs,
  count(*) FILTER(WHERE f.valid_until<=now()) AS expired,
  min(q.available_at) FILTER(WHERE q.dirty) AS next_dirty_at
FROM private.matchup_forecast_queue q LEFT JOIN public.matchup_forecasts f ON f.matchup_id=q.matchup_id;

SELECT scope,available_at,revision,after_matchup_id IS NOT NULL AS cursor_advanced
FROM private.forecast_refresh_requests ORDER BY available_at,scope LIMIT 40;

SELECT q.queryid,q.calls,round(q.mean_exec_time::numeric,2) AS mean_ms,
  round(q.total_exec_time::numeric,2) AS total_ms,
  q.shared_blks_hit+q.shared_blks_read AS buffers,q.query
FROM extensions.pg_stat_statements q
WHERE q.toplevel AND q.query LIKE 'WITH pgrst_source AS%'
  AND q.query LIKE '%"p_league_id"%' AND q.query LIKE '%"p_member_id"%' AND q.query LIKE '%"p_params"%'
ORDER BY q.total_exec_time DESC LIMIT 30;

SELECT kind,function_name,retired_at FROM private.work_kinds
WHERE kind IN('forecast-inputs','matchup-forecasts','notification-scan');

SELECT kind,status,count(*) AS items,min(due_at) AS first_due,
  min(lease_until) AS first_lease,max(attempts) AS attempts,
  count(*) FILTER(WHERE status='running' AND lease_until<=now()) AS expired_leases
FROM private.work_items WHERE status IN('pending','failed','running')
GROUP BY kind,status ORDER BY kind,status;

SELECT w.id,w.kind,w.key,w.status,w.attempts,w.due_at,w.lease_until,w.last_error,
  w.payload->>'schedulerChunk' AS chunk,e.worker_status,e.queued_at,e.worker_started_at,e.worker_finished_at,
  s.rows_affected,s.error AS worker_error
FROM private.work_items w LEFT JOIN public.edge_invocations e ON e.work_item_id=w.id
LEFT JOIN public.sync_runs s ON s.id=e.sync_run_id
WHERE w.kind='forecast-inputs' ORDER BY w.id DESC LIMIT 30;

SELECT r.scope,r.available_at,r.matchup_id IS NOT NULL AS has_matchup_id,r.after_matchup_id,
  m.is_voided,s.is_current,l.deleted_at IS NOT NULL AS league_deleted,
  first_week.week_start,last_week.week_end,q.input_fingerprint->>'validUntil' AS fingerprint_deadline
FROM private.forecast_refresh_requests r LEFT JOIN public.matchups m ON m.id=r.matchup_id
LEFT JOIN public.league_seasons s ON s.id=m.league_season_id LEFT JOIN public.leagues l ON l.id=m.league_id
LEFT JOIN public.season_weeks first_week ON first_week.season_year=s.season_year AND first_week.week_number=m.week_number
LEFT JOIN public.season_weeks last_week ON last_week.season_year=s.season_year AND last_week.week_number=coalesce(m.end_week_number,m.week_number)
LEFT JOIN private.matchup_forecast_queue q ON q.matchup_id=m.id
WHERE r.available_at<=now() ORDER BY r.available_at,r.scope LIMIT 100;

SELECT pid,state,wait_event_type,wait_event,now()-xact_start AS transaction_age,pg_blocking_pids(pid) AS blocking
FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend'
AND pid<>pg_backend_pid() ORDER BY xact_start NULLS LAST LIMIT 30;

SELECT p.oid::regprocedure AS function,md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p WHERE p.oid IN('private.complete_forecast_input_chunk()'::regprocedure,
  'private.refresh_matchup_forecast_input(uuid)'::regprocedure,'private.work_claim(integer)'::regprocedure,
  'public.run_scheduler_chunk(text,boolean,timestamptz)'::regprocedure);
