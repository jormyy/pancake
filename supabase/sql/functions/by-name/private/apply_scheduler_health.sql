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
