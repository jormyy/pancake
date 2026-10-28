SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE OR REPLACE FUNCTION private.retain_cron_job_run_details(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.runid FROM cron.job_run_details r
    WHERE (r.status IN ('succeeded','failed') AND COALESCE(r.end_time,r.start_time)<p_now-interval '24 hours')
      OR (r.status NOT IN ('succeeded','failed') AND r.start_time<p_now-interval '24 hours'
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity active
          WHERE active.pid=r.job_pid AND active.backend_start<=r.start_time))
    ORDER BY r.runid LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM cron.job_run_details r USING victims v WHERE r.runid=v.runid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('cron.job_run_details',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
  v_utc timestamp:=p_now AT TIME ZONE 'UTC'; v_key text:=date_trunc('minute',p_now)::text;
BEGIN
  PERFORM private.enqueue_close_expired_nominations(p_now);
  PERFORM private.enqueue_stats_sync_dispatch(p_now);
  PERFORM private.enqueue_process_trades(p_now);
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  PERFORM private.enqueue_matchup_forecasts(p_now);
  PERFORM private.enqueue_screen_views(p_now);
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    PERFORM private.enqueue_daily('sync-players',6,0,p_now);
    PERFORM private.enqueue_player_injuries(p_now);
    PERFORM private.enqueue_daily('process-waivers',3,0,p_now);
    PERFORM private.enqueue_season_boundary(p_now);
    PERFORM private.enqueue_projection_sync(p_now);
    IF (p_now AT TIME ZONE 'America/New_York')::time>=time '06:20' AND EXISTS(
      SELECT 1 FROM public.nba_games WHERE game_date BETWEEN (p_now AT TIME ZONE 'America/New_York')::date-7
      AND (p_now AT TIME ZONE 'America/New_York')::date-1 AND nba_game_id LIKE '002%' AND status='Final'
    ) THEN
      PERFORM private.work_enqueue('daily-stat-corrections',(p_now AT TIME ZONE 'America/New_York')::date::text,p_now);
    END IF;
  END IF;
  IF v_min%15=5 THEN PERFORM private.enqueue_daily('sync-schedule',6,5,p_now); END IF;
  IF v_min=0 THEN PERFORM private.enqueue_rankings(p_now); END IF;
  IF v_min%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
    WHERE reconciled_at IS NULL OR worker_status='running') THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now);
  END IF;
  IF v_min=17 THEN PERFORM private.work_enqueue('pg-net-response-vacuum',date_trunc('hour',p_now)::text,p_now,'{"action":"vacuum"}'); END IF;
  IF v_min=0 AND extract(hour FROM v_utc)=13 AND
    ((extract(month FROM v_utc)=6 AND extract(day FROM v_utc)>=20) OR
     (extract(month FROM v_utc)=7 AND extract(day FROM v_utc)<=15)) THEN
    PERFORM private.work_enqueue('sync-draft-order',v_utc::date::text,p_now);
  END IF;
  IF extract(hour FROM v_utc)=8 AND v_min=35 THEN PERFORM private.work_enqueue('cleanup-trade-estimates',v_utc::date::text,p_now); END IF;
  IF extract(hour FROM v_utc)=9 AND v_min=30 THEN PERFORM private.work_enqueue('mock-room-expiry',v_utc::date::text,p_now); END IF;
  IF v_utc::time>=time '10:00' THEN
    PERFORM private.work_enqueue('retention-prune',v_utc::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp();
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  PERFORM private.enqueue_scheduled_work(now());
  IF NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE status IN ('pending','failed') AND due_at<=now()
      OR status='running' AND lease_until<=now()) THEN RETURN 0; END IF;
  LOOP
    EXIT WHEN v_count>=8 OR clock_timestamp()-v_started>=interval '2 seconds';
    SELECT * INTO v_item FROM private.work_claim(1);
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

CREATE OR REPLACE FUNCTION private.work_enqueue(p_kind text, p_key text, p_due_at timestamptz DEFAULT now(), p_payload jsonb DEFAULT '{}'::jsonb, p_league_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id bigint;
BEGIN
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind=p_kind AND key=p_key) THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM private.work_items
    WHERE kind=p_kind AND status IN ('pending','running','failed')
      AND (CASE WHEN kind='pre-tipoff' THEN payload->>'tipoffAt' ELSE md5(payload::text) END)
        =(CASE WHEN p_kind='pre-tipoff' THEN p_payload->>'tipoffAt' ELSE md5(p_payload::text) END)
  ) THEN RETURN NULL; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
  VALUES(p_kind,p_key,p_due_at,p_payload,p_league_id)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

UPDATE private.retention_rules SET retention_rule='24 hours; active executions stay; 5000 rows per batch' WHERE relation_name='cron.job_run_details';
SELECT cron.schedule('io-hint-drain','30 seconds','SELECT private.flush_player_stats_hints() WHERE NOT (SELECT paused FROM private.worker_controls WHERE id); SELECT private.flush_league_inventory_hints(1000) WHERE NOT (SELECT paused FROM private.worker_controls WHERE id)');
SELECT cron.schedule('io-cron-history-retention','12 * * * *','SELECT private.retain_cron_job_run_details() WHERE NOT (SELECT paused FROM private.worker_controls WHERE id)');

ALTER TABLE private.work_items SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE private.screen_refresh_queue SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE private.matchup_forecast_queue SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE private.score_input_revisions SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE public.league_change_hints SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE public.league_versions SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE private.league_version_pending SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE public.player_game_stats SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE public.nba_games SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE public.edge_invocations SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE public.perf_beacons SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE private.request_receipts SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);

ALTER TABLE public.league_events SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05);



RESET statement_timeout;
RESET lock_timeout;
