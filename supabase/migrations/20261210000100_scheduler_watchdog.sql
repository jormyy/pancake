BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
ALTER TABLE private.worker_controls
  ADD COLUMN scheduler_level text NOT NULL DEFAULT 'normal' CHECK(scheduler_level IN ('normal','shed','paused')),
  ADD COLUMN scheduler_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN scheduler_checked_at timestamptz,
  ADD COLUMN scheduler_healthy_since timestamptz,
  ADD COLUMN scheduler_last_dispatch_at timestamptz,
  ADD COLUMN scheduler_health jsonb;
CREATE TABLE private.scheduler_health_log(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  previous_level text NOT NULL CHECK(previous_level IN ('normal','shed','paused')),
  level text NOT NULL CHECK(level IN ('normal','shed','paused')),
  reason text NOT NULL,
  health jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE private.scheduler_health_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.scheduler_health_log FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON private.scheduler_health_log TO service_role;
CREATE TABLE public.scheduler_health_hint(
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  level text NOT NULL CHECK(level IN ('normal','shed','paused')),
  revision bigint NOT NULL,
  changed_at timestamptz NOT NULL,
  reason text NOT NULL
);
ALTER TABLE public.scheduler_health_hint ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scheduler_health_hint FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.scheduler_health_hint TO service_role;

INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
  ('private.scheduler_health_log','One operational record per scheduler state change'),
  ('public.scheduler_health_hint','One current scheduler state hint; updated in place');

CREATE OR REPLACE FUNCTION private.scheduler_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_health jsonb;
BEGIN
  WITH recent AS MATERIALIZED (
    SELECT jobid,status,start_time,end_time,return_message
    FROM cron.job_run_details ORDER BY runid DESC LIMIT 40
  ), window_runs AS MATERIALIZED (
    SELECT * FROM recent WHERE start_time>=v_now-interval '5 minutes' AND start_time<=v_now
  ), runs AS (
    SELECT count(*) AS samples,
      count(*) FILTER(WHERE status='succeeded')::numeric/nullif(count(*),0) AS success_ratio,
      avg(extract(epoch FROM end_time-start_time)) AS avg_duration_seconds,
      max(extract(epoch FROM end_time-start_time)) AS max_duration_seconds,
      max(end_time) AS last_completed_at
    FROM window_runs
    WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='work-dispatcher')
      AND status IN ('succeeded','failed')
  ), timeouts AS (
    SELECT count(*) AS startup_timeouts FROM window_runs
    WHERE return_message LIKE '%job startup timeout%'
  ), backends AS (
    SELECT count(*) FILTER(WHERE state='active') AS active_backends,
      count(*) FILTER(WHERE wait_event_type='Lock') AS lock_waiters
    FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
  )
  SELECT jsonb_build_object('available',true,'checked_at',v_now,'window_seconds',300,
    'row_limit',40,'rows_checked',(SELECT count(*) FROM recent))
    ||to_jsonb(runs)||to_jsonb(timeouts)||to_jsonb(backends)
  INTO v_health FROM runs,timeouts,backends;
  RETURN v_health;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  RETURN jsonb_build_object('available',false,'checked_at',clock_timestamp(),'window_seconds',300,'error_code',SQLSTATE);
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_scheduler_health(p_health jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' AS $$
DECLARE v_control private.worker_controls%ROWTYPE; v_level text; v_reason text;
  v_now timestamptz:=(p_health->>'checked_at')::timestamptz;
  v_healthy_since timestamptz; v_healthy boolean;
BEGIN
  SELECT * INTO STRICT v_control FROM private.worker_controls WHERE id FOR UPDATE;
  v_level:=v_control.scheduler_level;
  v_healthy:=coalesce((p_health->>'available')::boolean,false)
    AND coalesce((p_health->>'samples')::int,0)>0
    AND (p_health->>'success_ratio')::numeric>=0.8
    AND (p_health->>'avg_duration_seconds')::numeric<=3
    AND (p_health->>'startup_timeouts')::int=0;
  IF NOT coalesce((p_health->>'available')::boolean,false) THEN
    IF v_level='normal' THEN v_level:='shed'; END IF;
    v_reason:='health unavailable';
  ELSIF (p_health->>'startup_timeouts')::int>0 OR (p_health->>'success_ratio')::numeric<0.5 THEN
    v_level:='paused';
    v_reason:='startup timeout or success below 50%';
  ELSIF (p_health->>'success_ratio')::numeric<0.8 OR (p_health->>'avg_duration_seconds')::numeric>3 THEN
    IF v_level='normal' THEN v_level:='shed'; END IF;
    v_reason:='success below 80% or average above 3 seconds';
  ELSIF v_healthy AND v_level<>'normal' THEN
    v_healthy_since:=CASE WHEN v_control.scheduler_checked_at>=v_now-interval '90 seconds'
      AND v_control.scheduler_checked_at<=v_now THEN v_control.scheduler_healthy_since END;
    v_healthy_since:=coalesce(v_healthy_since,v_now);
    IF v_now-v_healthy_since>=interval '10 minutes' THEN
      v_level:='normal';
      v_reason:='ten consecutive healthy minutes';
      v_healthy_since:=NULL;
    END IF;
  END IF;
  UPDATE private.worker_controls SET scheduler_level=v_level,scheduler_checked_at=v_now,
    scheduler_healthy_since=v_healthy_since,scheduler_health=p_health,
    scheduler_changed_at=CASE WHEN v_level<>v_control.scheduler_level THEN v_now ELSE scheduler_changed_at END
  WHERE id;
  IF v_level<>v_control.scheduler_level THEN
    INSERT INTO private.scheduler_health_log(previous_level,level,reason,health,created_at)
    VALUES(v_control.scheduler_level,v_level,v_reason,p_health,v_now);
    INSERT INTO public.scheduler_health_hint AS hint(id,level,revision,changed_at,reason)
    VALUES(true,v_level,1,v_now,v_reason)
    ON CONFLICT(id) DO UPDATE SET level=excluded.level,revision=hint.revision+1,
      changed_at=excluded.changed_at,reason=excluded.reason;
  END IF;
  RETURN v_level;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_scheduler_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' AS $$
  SELECT jsonb_build_object('level',scheduler_level,'paused',paused,'changed_at',scheduler_changed_at,
    'checked_at',scheduler_checked_at,'healthy_since',scheduler_healthy_since,
    'last_reduced_dispatch_at',scheduler_last_dispatch_at,'health',scheduler_health,
    'hint',(SELECT to_jsonb(hint)-'id' FROM public.scheduler_health_hint hint WHERE id))
  FROM private.worker_controls WHERE id
$$;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp(); v_level text; v_kinds text[]; v_waiver record; v_day date;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  v_level:=private.apply_scheduler_health(private.scheduler_health());
  IF clock_timestamp()-v_started>=interval '2 seconds' THEN RETURN 0; END IF;
  IF v_level='normal' THEN
    PERFORM private.enqueue_scheduled_work(now());
  ELSE
    IF v_level='paused' THEN
      UPDATE private.worker_controls SET scheduler_last_dispatch_at=clock_timestamp()
      WHERE id AND (scheduler_last_dispatch_at IS NULL OR scheduler_last_dispatch_at<=clock_timestamp()-interval '5 minutes');
      IF NOT FOUND THEN RETURN 0; END IF;
      v_kinds:=ARRAY['process-waivers','process-trades','live-poll'];
    ELSE
      v_kinds:=ARRAY['live-poll','sync-scores','stats-sync','process-waivers','process-trades','edge-invocation-reconcile'];
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
      OR status='running' AND lease_until<=now()) THEN RETURN 0; END IF;
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

REVOKE ALL ON FUNCTION private.scheduler_health(),private.apply_scheduler_health(jsonb),public.get_scheduler_health() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_scheduler_health() TO service_role;
COMMIT;
