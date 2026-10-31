CREATE OR REPLACE FUNCTION private.release_stalled_live_poll()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row record; v_count integer:=0;
BEGIN
  FOR v_row IN
    SELECT item.id,item.lease_token,inv.worker_started_at
    FROM private.work_items item
    JOIN public.edge_invocations inv ON inv.invocation_key=item.invocation_key AND inv.work_lease_token=item.lease_token
    WHERE item.kind='live-poll' AND item.status='running' AND item.lease_until>clock_timestamp()
      AND inv.worker_finished_at IS NULL
      AND CASE WHEN inv.worker_started_at IS NULL THEN
        inv.queued_at<=clock_timestamp()-interval '2 minutes' OR EXISTS(
          SELECT 1 FROM net._http_response resp
          WHERE resp.id=inv.request_id AND resp.created>=inv.queued_at-interval '1 minute'
            AND (resp.error_msg IS NOT NULL OR resp.timed_out IS TRUE OR resp.status_code NOT BETWEEN 200 AND 299))
      ELSE
        item.lease_until<=clock_timestamp()+interval '210 seconds'
        AND NOT EXISTS(SELECT 1 FROM public.live_poll_leases lease WHERE lease.lock_key=779001 AND lease.expires_at>clock_timestamp())
      END
    FOR UPDATE OF inv,item SKIP LOCKED
  LOOP
    IF private.work_finish(v_row.id,v_row.lease_token,CASE WHEN v_row.worker_started_at IS NULL
      THEN 'Worker never started' ELSE 'Worker stopped renewing its lease' END) THEN
      UPDATE private.work_items SET due_at=now() WHERE id=v_row.id AND status='failed';
      v_count:=v_count+1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION private.release_stalled_live_poll() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp(); v_level text; v_kinds text[]; v_waiver record; v_day date;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  PERFORM private.release_stalled_live_poll();
  v_count:=private.dispatch_live_matchup_refresh();
  v_level:=private.apply_scheduler_health(private.scheduler_health());
  IF clock_timestamp()-v_started>=interval '2 seconds' THEN RETURN v_count; END IF;
  IF v_level='normal' THEN
    PERFORM private.enqueue_scheduled_work(now());
  ELSE
    IF v_level='paused' THEN
      UPDATE private.worker_controls SET scheduler_last_dispatch_at=clock_timestamp()
      WHERE id AND (scheduler_last_dispatch_at IS NULL OR scheduler_last_dispatch_at<=clock_timestamp()-interval '5 minutes');
      IF NOT FOUND THEN RETURN v_count; END IF;
      v_kinds:=ARRAY['process-waivers','process-trades','live-poll','refresh-live-matchups'];
    ELSE
      v_kinds:=ARRAY['live-poll','sync-scores','stats-sync','process-waivers','process-trades','edge-invocation-reconcile','refresh-live-matchups'];
      PERFORM private.enqueue_stats_sync_dispatch(now());
      IF extract(minute FROM now())::int%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
        WHERE reconciled_at IS NULL OR worker_status='running') THEN
        PERFORM private.work_enqueue('edge-invocation-reconcile',date_trunc('minute',now())::text,now());
      END IF;
    END IF;
    PERFORM private.enqueue_process_trades(now());
    IF v_level='paused' OR extract(minute FROM now())::int%2=0 THEN PERFORM private.enqueue_live_poll(now()); END IF;
    IF v_level='paused' OR extract(minute FROM now())::int%15=0 THEN
      FOR v_waiver IN SELECT DISTINCT coalesce(timezone,'America/Los_Angeles') AS timezone
        FROM public.leagues WHERE status IN ('active','playoffs','offseason') LOOP
        v_day:=(now() AT TIME ZONE v_waiver.timezone)::date;
        PERFORM private.work_enqueue('process-waivers',v_waiver.timezone||':'||v_day::text,
          v_day::timestamp AT TIME ZONE v_waiver.timezone,jsonb_build_object('timezone',v_waiver.timezone,'date',v_day));
      END LOOP;
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE status IN ('pending','failed') AND due_at<=now()
      OR status='running' AND lease_until<=now()) THEN RETURN v_count; END IF;
  LOOP
    EXIT WHEN v_count>=4 OR clock_timestamp()-v_started>=interval '2 seconds';
    IF v_level='normal' THEN
      SELECT * INTO v_item FROM private.work_claim(1);
    ELSE
      PERFORM private.work_claim(0);
      WITH due AS (
        SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
          AND kind=ANY(v_kinds)
          AND (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<4
        ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE private.work_items item SET status='running',attempts=attempts+1,
        lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
      FROM due WHERE item.id=due.id RETURNING item.* INTO v_item;
    END IF;
    EXIT WHEN NOT FOUND;
    BEGIN
      PERFORM private.work_execute(v_item.id,v_item.lease_token);
    EXCEPTION WHEN OTHERS THEN
      PERFORM private.work_finish(v_item.id,v_item.lease_token,SQLERRM);
    END;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;
