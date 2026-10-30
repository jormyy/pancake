BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=p_now)
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=p_now) THEN
    PERFORM private.work_enqueue('forecast-inputs',date_trunc('minute',p_now)::text,p_now,'{"schedulerChunk":"forecasts"}');
  END IF;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND NOT private.matchup_forecast_refresh_pending(matchup_id)
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
  v_waiver record; v_waiver_day date; v_waiver_due timestamptz;
  v_utc timestamp:=p_now AT TIME ZONE 'UTC'; v_key text:=date_trunc('minute',p_now)::text;
BEGIN
  PERFORM private.enqueue_close_expired_nominations(p_now);
  IF EXISTS (
    SELECT 1
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND (
         job.status = 'pending'
         OR (
           job.status = 'failed'
           AND job.failed_items < 3
           AND COALESCE(job.completed_at, job.created_at) <= (p_now + interval '1 minute') - make_interval(
             secs => CASE WHEN job.failed_items <= 1 THEN 60 ELSE 300 END
           )
         )
         OR (
           job.status = 'running'
           AND (
             (
               job.claim_token IS NULL
               AND COALESCE(job.claimed_at, job.created_at) <= (p_now + interval '1 minute') - interval '15 minutes'
             )
             OR (
               job.claim_token IS NOT NULL
               AND (
                 job.claimed_at IS NULL
                 OR job.claimed_at <= (p_now + interval '1 minute') - interval '120 seconds'
               )
             )
           )
         )
       )
  ) THEN
    PERFORM private.work_enqueue(
      'stats-sync',date_trunc('minute',p_now)::text,p_now,
      '{"dispatch":true,"jobId":"00000000-0000-4000-8000-000000000000"}'::jsonb
    );
  END IF;
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= p_now
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= p_now
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= p_now
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= p_now - interval '60 seconds')
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NOT NULL
      AND queued.available_at <= p_now
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= p_now - interval '60 seconds')
  ) THEN
    PERFORM private.work_enqueue('process-trades',date_trunc('minute',p_now)::text,p_now);
  END IF;
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  IF EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=p_now)
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=p_now) THEN
    PERFORM private.work_enqueue('forecast-inputs',date_trunc('minute',p_now)::text,p_now,'{"schedulerChunk":"forecasts"}');
  END IF;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND NOT private.matchup_forecast_refresh_pending(matchup_id)
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
  PERFORM private.enqueue_screen_views(p_now);
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    PERFORM private.enqueue_daily('sync-players',6,0,p_now);
    PERFORM private.enqueue_daily('sync-trade-values',7,15,p_now);
    PERFORM private.enqueue_daily('missing-final-stats',6,30,p_now);
    PERFORM private.enqueue_player_injuries(p_now);
    FOR v_waiver IN SELECT DISTINCT coalesce(timezone, 'America/Los_Angeles') AS timezone
      FROM public.leagues WHERE status IN ('active', 'playoffs', 'offseason') LOOP
      v_waiver_day := (p_now AT TIME ZONE v_waiver.timezone)::date;
      v_waiver_due := v_waiver_day::timestamp AT TIME ZONE v_waiver.timezone;
      PERFORM private.work_enqueue('process-waivers', v_waiver.timezone || ':' || v_waiver_day::text, v_waiver_due, jsonb_build_object('timezone', v_waiver.timezone, 'date', v_waiver_day));
    END LOOP;
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
  IF v_min%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
    WHERE reconciled_at IS NULL OR worker_status='running') THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now);
  END IF;
  IF v_min=0 THEN PERFORM private.enqueue_rankings(p_now); END IF;
  IF v_min>=17 THEN
    PERFORM private.work_enqueue('public-read-retention',date_trunc('hour',p_now)::text,p_now);
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

CREATE OR REPLACE FUNCTION private.complete_forecast_input_chunk()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE requested private.forecast_refresh_requests%ROWTYPE; matchup uuid; due timestamptz; processed integer:=0; input_revision bigint;
BEGIN
  SELECT matchup_id INTO matchup FROM private.matchup_forecast_expiries WHERE available_at<=now()
    ORDER BY available_at,matchup_id LIMIT 1;
  IF FOUND THEN
    PERFORM 1 FROM public.matchups WHERE id=matchup FOR KEY SHARE;
    IF FOUND THEN PERFORM private.queue_matchup_forecasts(NULL,matchup); END IF;
    DELETE FROM private.matchup_forecast_expiries WHERE matchup_id=matchup AND available_at<=now();
    RETURN jsonb_build_object('processed',0,'remaining',true);
  END IF;
  SELECT * INTO requested FROM private.forecast_refresh_requests WHERE available_at<=now()
    ORDER BY available_at,scope LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('processed',0,'remaining',false); END IF;
  IF requested.matchup_id IS NOT NULL THEN
    matchup:=requested.matchup_id;
  ELSE
    SELECT item.id INTO matchup FROM public.matchups item
    JOIN public.league_seasons season ON season.id=item.league_season_id AND season.is_current
    JOIN public.leagues league ON league.id=item.league_id AND league.deleted_at IS NULL
    JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=item.week_number
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(item.end_week_number,item.week_number)
    WHERE NOT item.is_voided AND (requested.league_id IS NULL OR item.league_id=requested.league_id)
      AND (requested.after_matchup_id IS NULL OR item.id>requested.after_matchup_id)
      AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1
      AND first_week.week_start<=(now() AT TIME ZONE 'America/New_York')::date+14
    ORDER BY item.id LIMIT 1;
  END IF;
  IF matchup IS NULL THEN
    DELETE FROM private.forecast_refresh_requests WHERE scope=requested.scope;
  ELSE
    SELECT current.revision INTO input_revision FROM private.forecast_refresh_requests current WHERE scope='matchup:'||matchup;
    due:=private.refresh_matchup_forecast_input(matchup);
    processed:=1;
    IF requested.matchup_id IS NOT NULL THEN
      IF due IS NULL THEN DELETE FROM private.forecast_refresh_requests WHERE scope=requested.scope;
      ELSE UPDATE private.forecast_refresh_requests SET available_at=due,after_matchup_id=NULL WHERE scope=requested.scope;
      END IF;
    ELSE
      UPDATE private.forecast_refresh_requests SET after_matchup_id=matchup WHERE scope=requested.scope;
      IF due IS NOT NULL THEN
        IF input_revision IS NOT NULL THEN
          UPDATE private.forecast_refresh_requests SET available_at=due,after_matchup_id=NULL
            WHERE scope='matchup:'||matchup AND revision=input_revision;
        ELSE
          INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
            VALUES('matchup:'||matchup,matchup,due) ON CONFLICT DO NOTHING;
        END IF;
      END IF;
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=now()
    AND NOT private.matchup_forecast_refresh_pending(matchup_id)
    AND (claimed_at IS NULL OR claimed_at<now()-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',now())::text,now());
  END IF;
  RETURN jsonb_build_object('processed',processed,'remaining',EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now())
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=now()));
END;
$$;

COMMIT;
