SET lock_timeout='5s';
SET statement_timeout='60s';
CREATE INDEX IF NOT EXISTS sync_runs_retention_success ON public.sync_runs(finished_at,id) WHERE status='success' AND error IS NULL AND finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sync_runs_health_success ON public.sync_runs(function_name,started_at DESC,id DESC) WHERE status='success' AND error IS NULL AND finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sync_runs_retention_failed ON public.sync_runs(finished_at,id) WHERE (status='failed' OR error IS NOT NULL) AND finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sync_runs_health_failed ON public.sync_runs(function_name,started_at DESC,id DESC) WHERE (status='failed' OR error IS NOT NULL) AND finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS edge_invocations_retention_success ON public.edge_invocations(reconciled_at,id) WHERE status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM 'failed' AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running';
CREATE INDEX IF NOT EXISTS edge_invocations_health_success ON public.edge_invocations(function_name,queued_at DESC,id DESC) WHERE status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM 'failed' AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running';
CREATE INDEX IF NOT EXISTS edge_invocations_retention_failed ON public.edge_invocations(reconciled_at,id) WHERE (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running';
CREATE INDEX IF NOT EXISTS edge_invocations_health_failed ON public.edge_invocations(function_name,queued_at DESC,id DESC) WHERE (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running';

CREATE OR REPLACE FUNCTION private.delete_projection_runs(p_ids uuid[],p_row_budget integer DEFAULT 10000)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_run uuid; v_rows integer:=0; v_runs integer:=0; v_count integer; v_batch integer;
  v_previous text:=COALESCE(current_setting('pancake.projection_cleanup',true),'');
BEGIN
  PERFORM set_config('pancake.projection_cleanup','on',true);
  FOR v_run IN SELECT id FROM public.projection_sync_runs WHERE id=ANY(p_ids)
    ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED
  LOOP
    LOOP
      v_batch:=LEAST(500,GREATEST(p_row_budget-v_rows,0));
      EXIT WHEN v_batch=0;
      WITH victims AS (
        SELECT id FROM public.fantasypros_projection_rows WHERE run_id=v_run
        ORDER BY id LIMIT v_batch FOR UPDATE SKIP LOCKED
      ) DELETE FROM public.fantasypros_projection_rows r USING victims v WHERE r.id=v.id;
      GET DIAGNOSTICS v_count=ROW_COUNT;
      v_rows:=v_rows+v_count;
      EXIT WHEN v_count<v_batch;
    END LOOP;
    DELETE FROM public.projection_sync_runs r WHERE id=v_run
      AND NOT EXISTS(SELECT 1 FROM public.fantasypros_projection_rows p WHERE p.run_id=r.id);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_runs:=v_runs+v_count;
    EXIT WHEN v_rows>=p_row_budget;
  END LOOP;
  PERFORM set_config('pancake.projection_cleanup',v_previous,true);
  RETURN jsonb_build_object('projection_sync_runs',v_runs,'fantasypros_projection_rows',v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION private.compact_fantasypros_runs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_ids uuid[];
BEGIN
  IF NEW.source<>'fantasypros' OR NEW.status<>'success' OR NEW.completed_at IS NULL
    OR OLD.status='success' AND OLD.completed_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.projection_sync_runs r WHERE r.source='fantasypros'
      AND r.projection_type=NEW.projection_type AND r.status='success' AND r.completed_at IS NOT NULL
      AND (r.started_at,r.id)<(NEW.started_at,NEW.id)
      AND (NEW.projection_type='daily' AND r.projection_date=NEW.projection_date
        OR NEW.projection_type<>'daily' AND r.season_year=NEW.season_year AND r.week_number=NEW.week_number)
    ORDER BY r.started_at LIMIT 200
  ) old_runs;
  PERFORM private.delete_projection_runs(v_ids,100000);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_unbounded_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '250ms'
AS $$
DECLARE
  v_sync_runs bigint:=0; v_edge_invocations bigint:=0; v_cron_runs bigint:=0;
  v_sleeper_rows bigint:=0; v_projection_counts jsonb; v_ids uuid[]; v_count integer; v_total integer; v_cursor bigint:=0; v_scan_count integer; v_scan_ids bigint[];
  v_before date:=date_trunc('week',timezone('America/Los_Angeles',now()))::date;
  v_previous text:=COALESCE(current_setting('pancake.projection_cleanup',true),'');
BEGIN
  v_total:=0;
  LOOP
    WITH victims AS (
      SELECT r.id FROM public.sync_runs r
      WHERE status='success' AND error IS NULL AND finished_at IS NOT NULL AND finished_at<now()-interval '7 days'
        AND r.id<>(SELECT newest.id FROM public.sync_runs newest
          WHERE newest.function_name=r.function_name AND status='success' AND error IS NULL AND finished_at IS NOT NULL
          ORDER BY newest.started_at DESC,newest.id DESC LIMIT 1)
      ORDER BY finished_at,r.id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM public.sync_runs r USING victims v WHERE r.id=v.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_sync_runs:=v_sync_runs+v_count; v_total:=v_total+v_count;
    EXIT WHEN v_count<500 OR v_total>=20000;
  END LOOP;
  v_total:=0;
  LOOP
    WITH victims AS (
      SELECT r.id FROM public.sync_runs r
      WHERE (status='failed' OR error IS NOT NULL) AND finished_at IS NOT NULL AND finished_at<now()-interval '30 days'
        AND r.id<>(SELECT newest.id FROM public.sync_runs newest
          WHERE newest.function_name=r.function_name AND (status='failed' OR error IS NOT NULL) AND finished_at IS NOT NULL
          ORDER BY newest.started_at DESC,newest.id DESC LIMIT 1)
      ORDER BY finished_at,r.id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM public.sync_runs r USING victims v WHERE r.id=v.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_sync_runs:=v_sync_runs+v_count; v_total:=v_total+v_count;
    EXIT WHEN v_count<500 OR v_total>=20000;
  END LOOP;
  v_total:=0;
  LOOP
    WITH victims AS (
      SELECT r.id FROM public.edge_invocations r
      WHERE status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM 'failed' AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running' AND reconciled_at<now()-interval '7 days'
        AND r.id<>(SELECT newest.id FROM public.edge_invocations newest
          WHERE newest.function_name=r.function_name AND status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM 'failed' AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running'
          ORDER BY newest.queued_at DESC,newest.id DESC LIMIT 1)
      ORDER BY reconciled_at,r.id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM public.edge_invocations r USING victims v WHERE r.id=v.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_edge_invocations:=v_edge_invocations+v_count; v_total:=v_total+v_count;
    EXIT WHEN v_count<500 OR v_total>=20000;
  END LOOP;
  v_total:=0;
  LOOP
    WITH victims AS (
      SELECT r.id FROM public.edge_invocations r
      WHERE (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running' AND reconciled_at<now()-interval '30 days'
        AND r.id<>(SELECT newest.id FROM public.edge_invocations newest
          WHERE newest.function_name=r.function_name AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM 'running'
          ORDER BY newest.queued_at DESC,newest.id DESC LIMIT 1)
      ORDER BY reconciled_at,r.id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM public.edge_invocations r USING victims v WHERE r.id=v.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_edge_invocations:=v_edge_invocations+v_count; v_total:=v_total+v_count;
    EXIT WHEN v_count<500 OR v_total>=20000;
  END LOOP;
  v_total:=0;
  LOOP
    SELECT array_agg(runid),max(runid),count(*) INTO v_scan_ids,v_cursor,v_scan_count
    FROM (SELECT runid FROM cron.job_run_details WHERE runid>v_cursor ORDER BY runid LIMIT 1000) page;
    EXIT WHEN v_scan_count=0;
    WITH victims AS (
      SELECT runid FROM cron.job_run_details WHERE runid=ANY(v_scan_ids)
        AND (status='succeeded' AND COALESCE(end_time,start_time)<now()-interval '7 days'
          OR status='failed' AND COALESCE(end_time,start_time)<now()-interval '30 days')
      FOR UPDATE SKIP LOCKED
    ) DELETE FROM cron.job_run_details r USING victims v WHERE r.runid=v.runid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_cron_runs:=v_cron_runs+v_count; v_total:=v_total+v_scan_count;
    EXIT WHEN v_scan_count<1000 OR v_total>=200000;
  END LOOP;
  PERFORM set_config('pancake.projection_cleanup','on',true);
  WITH victims AS (
    SELECT id FROM public.sleeper_projection_rows WHERE game_date<v_before
    ORDER BY game_date,id LIMIT 10000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.sleeper_projection_rows r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_sleeper_rows=ROW_COUNT;

  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.projection_sync_runs WHERE projection_period_end<v_before
    ORDER BY projection_period_end,id LIMIT 200
  ) expired;
  v_projection_counts:=private.delete_projection_runs(v_ids);
  PERFORM set_config('pancake.projection_cleanup',v_previous,true);
  RETURN jsonb_build_object(
    'sync_runs',v_sync_runs,'edge_invocations',v_edge_invocations,'cron_job_run_details',v_cron_runs,
    'projection_sync_runs',(v_projection_counts->>'projection_sync_runs')::integer,
    'fantasypros_projection_rows',(v_projection_counts->>'fantasypros_projection_rows')::integer,
    'sleeper_projection_rows',v_sleeper_rows,
    'weekly_lineups',0,'standings',0,'roster_transactions',0,'dynasty_news',0
  );
END;
$$;

REVOKE ALL ON FUNCTION private.delete_projection_runs(uuid[],integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.compact_fantasypros_runs() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER compact_fantasypros_success AFTER UPDATE ON public.projection_sync_runs
  FOR EACH ROW EXECUTE FUNCTION private.compact_fantasypros_runs();
