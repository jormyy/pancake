-- Canonical SQL source for public.prune_unbounded_history.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.prune_unbounded_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '250ms'
AS $$
DECLARE
  v_requests bigint:=0;
  v_outbox bigint:=0;
  v_sync_runs bigint:=0; v_edge_invocations bigint:=0; v_cron_runs bigint:=0;
  v_sleeper_rows bigint:=0; v_projection_counts jsonb; v_ids uuid[]; v_count integer; v_total integer; v_cursor bigint:=0; v_scan_count integer; v_scan_ids bigint[];
  v_before date:=date_trunc('week',timezone('America/Los_Angeles',now()))::date;
  v_previous text:=COALESCE(current_setting('pancake.projection_cleanup',true),'');
BEGIN
  v_total:=0;
  LOOP
    WITH victims AS (
      SELECT request_id FROM private.request_receipts
      WHERE created_at < now() - interval '7 days'
      ORDER BY created_at, request_id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM private.request_receipts r USING victims v WHERE r.request_id=v.request_id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_requests:=v_requests+v_count; v_total:=v_total+v_count;
    EXIT WHEN v_count<500 OR v_total>=20000;
  END LOOP;
  v_total:=0;
  LOOP
    WITH victims AS (
      SELECT id FROM public.notification_outbox
      WHERE COALESCE(delivered_at,dead_lettered_at,suppressed_at)<now()-interval '60 days'
      ORDER BY COALESCE(delivered_at,dead_lettered_at,suppressed_at),id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM public.notification_outbox queued USING victims WHERE queued.id=victims.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_outbox:=v_outbox+v_count; v_total:=v_total+v_count;
    EXIT WHEN v_count<500 OR v_total>=20000;
  END LOOP;
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
      WHERE (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL OR worker_status='failed') AND worker_status IS DISTINCT FROM 'running' AND reconciled_at<now()-interval '30 days'
        AND r.id<>(SELECT newest.id FROM public.edge_invocations newest
          WHERE newest.function_name=r.function_name AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL OR worker_status='failed') AND worker_status IS DISTINCT FROM 'running'
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
    'request_receipts',v_requests,'notification_outbox',v_outbox,'sync_runs',v_sync_runs,'edge_invocations',v_edge_invocations,'cron_job_run_details',v_cron_runs,
    'projection_sync_runs',(v_projection_counts->>'projection_sync_runs')::integer,
    'fantasypros_projection_rows',(v_projection_counts->>'fantasypros_projection_rows')::integer,
    'sleeper_projection_rows',v_sleeper_rows,
    'weekly_lineups',0,'standings',0,'roster_transactions',0,'dynasty_news',0
  );
END;
$$;
