CREATE OR REPLACE FUNCTION private.work_claim(p_limit integer DEFAULT 64)
RETURNS SETOF private.work_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_budget integer; v_count integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.work_claim',0)) THEN RETURN; END IF;
  FOR v_item IN SELECT * FROM private.work_items WHERE status='running' AND lease_until<=now()
    ORDER BY lease_until,id LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE private.work_items SET lease_until=now()+interval '1 second' WHERE id=v_item.id;
    PERFORM private.work_finish(v_item.id,v_item.lease_token,'Worker lease expired');
  END LOOP;
  v_budget:=greatest(0,least(p_limit,4-(SELECT count(*)::integer FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())));
  IF v_budget=0 THEN RETURN; END IF;
  WHILE v_count<v_budget LOOP
    SELECT item.* INTO v_item FROM private.work_items item
      JOIN private.work_kinds kind ON kind.kind=item.kind AND kind.retired_at IS NULL
      CROSS JOIN LATERAL (
        SELECT CASE WHEN item.kind='matchup-forecasts' THEN
          (EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now())
            OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=now()))
          AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=now()
            AND NOT private.matchup_forecast_refresh_pending(matchup_id)
            AND (claimed_at IS NULL OR claimed_at<now()-interval '3 minutes'))
          ELSE item.kind IN('trade-revaluation','trade-revaluation-check','trade-revaluation-scan','forecast-inputs','notification-scan') END AS background
      ) priority
    WHERE item.status IN ('pending','failed') AND item.due_at<=now()
      AND (item.kind NOT IN('forecast-inputs','notification-scan') OR
        (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<3)
      AND (item.kind<>'trade-revaluation' OR
        (NOT EXISTS(SELECT 1 FROM private.work_items running WHERE running.kind='trade-revaluation'
          AND running.status='running' AND running.lease_until>clock_timestamp() AND running.league_id IS NOT DISTINCT FROM item.league_id)
        AND NOT EXISTS(SELECT 1 FROM private.trade_revaluation_leagues pace WHERE pace.league_id=item.league_id AND pace.next_allowed_at>now())))
    ORDER BY CASE WHEN item.kind='live-poll' THEN 0 ELSE 1 END,priority.background,CASE WHEN priority.background THEN kind.last_claimed_at END NULLS FIRST,item.due_at,item.id
    LIMIT 1 FOR UPDATE OF item SKIP LOCKED;
    EXIT WHEN NOT FOUND;
    IF v_item.kind='trade-revaluation' THEN
      IF EXISTS(SELECT 1 FROM private.work_items running WHERE running.kind='trade-revaluation' AND running.status='running'
        AND running.lease_until>clock_timestamp() AND running.league_id IS NOT DISTINCT FROM v_item.league_id) THEN CONTINUE; END IF;
      IF v_item.league_id IS NOT NULL THEN
        INSERT INTO private.trade_revaluation_leagues AS pace(league_id,next_allowed_at)
          VALUES(v_item.league_id,clock_timestamp()+interval '1 minute')
          ON CONFLICT(league_id) DO UPDATE SET next_allowed_at=EXCLUDED.next_allowed_at
          WHERE pace.next_allowed_at<=clock_timestamp();
        IF NOT FOUND THEN CONTINUE; END IF;
      END IF;
    END IF;
    UPDATE private.work_items item SET status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
      WHERE item.id=v_item.id RETURNING item.* INTO v_item;
    IF FOUND THEN
      IF v_item.kind IN('trade-revaluation','trade-revaluation-check','trade-revaluation-scan','forecast-inputs','notification-scan','matchup-forecasts') THEN
        UPDATE private.work_kinds SET last_claimed_at=clock_timestamp() WHERE kind=v_item.kind;
      END IF;
      RETURN NEXT v_item;
      v_count:=v_count+1;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp(); v_level text; v_kinds text[]; v_waiver record; v_day date;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  BEGIN
    PERFORM private.flush_player_stats_hints();
    PERFORM private.flush_league_inventory_hints(1000);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Hint publication will retry: %',SQLERRM;
  END;
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
    EXIT WHEN v_count>=32 OR clock_timestamp()-v_started>=interval '2 seconds';
    IF v_level='normal' THEN
      SELECT * INTO v_item FROM private.work_claim(1);
    ELSE
      PERFORM private.work_claim(0);
      WITH due AS (
        SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
          AND kind=ANY(v_kinds)
          AND (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<4
        ORDER BY CASE WHEN kind='live-poll' THEN 0 ELSE 1 END,due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
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
