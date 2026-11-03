ALTER TABLE public.lineup_optimizer_settings ADD COLUMN last_daily_optimized_date date;

CREATE OR REPLACE FUNCTION private.apply_scheduled_lineup(
  p_game_date date, p_league_id uuid, p_league_season_id uuid, p_member_id uuid, p_assignments jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_same boolean;
BEGIN
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_member_id::text), hashtext(p_game_date::text));
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.players WHERE id IN (
    SELECT (a->>'player_id')::uuid FROM jsonb_array_elements(p_assignments) a
  ) ORDER BY id FOR SHARE;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE (lower(p.injury_status) = 'out' OR lower(p.injury_status) LIKE 'ir%')
      AND COALESCE((a->>'expected_active')::boolean, true)
      AND NOT private.lineup_game_started(p.id, p_game_date)
  ) THEN
    RAISE EXCEPTION 'Injury status changed; retry with fresh players.' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE NOT private.lineup_game_started(p.id, p_game_date)
      AND COALESCE((a->>'expected_active')::boolean, true)
      AND NOT EXISTS (
        SELECT 1 FROM public.nba_games g
        WHERE g.game_date = p_game_date
          AND private.lineup_game_available(g.status, g.game_status_text)
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
      )
  ) THEN
    RAISE EXCEPTION 'Game schedule changed; retry with fresh games.' USING ERRCODE = '40001';
  END IF;

  SELECT NOT EXISTS (
    (SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = p_game_date
     EXCEPT SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a)
    UNION ALL
    (SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a
     EXCEPT SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = p_game_date)
  ) INTO v_same;

  IF NOT v_same THEN
    PERFORM public.auto_set_lineup_service_atomic(p_member_id, p_league_id, p_league_season_id,
      p_game_date, p_assignments);
  END IF;
  RETURN NOT v_same;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_pre_tipoff_lineup(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_assignments jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
  v_enabled boolean;
  v_same boolean;
BEGIN
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token <> p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.lineup_tipoff_members
    WHERE tipoff_at = p_tipoff_at AND member_id = p_member_id
      AND league_id = p_league_id AND league_season_id = p_league_season_id
      AND input_revision = v_dispatch.input_revision) THEN
    RETURN false;
  END IF;
  IF p_tipoff_at <= now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Tipoff window has closed.' USING ERRCODE = '40001';
  END IF;

  SELECT enabled INTO v_enabled FROM public.lineup_optimizer_settings
   WHERE league_id = p_league_id AND league_season_id = p_league_season_id
     AND member_id = p_member_id FOR UPDATE;
  IF NOT COALESCE(v_enabled, false) THEN RETURN false; END IF;

  v_same := NOT private.apply_scheduled_lineup(v_dispatch.game_date, p_league_id,
    p_league_season_id, p_member_id, p_assignments);
  INSERT INTO public.lineup_tipoff_members (tipoff_at, league_id, league_season_id, member_id, input_revision)
  VALUES (p_tipoff_at, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision);
  UPDATE public.lineup_optimizer_settings SET last_optimized_at = now()
   WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at;
  END IF;
  RETURN NOT v_same;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_daily_lineup(
  p_game_date date, p_league_id uuid, p_league_season_id uuid, p_member_id uuid, p_assignments jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_setting public.lineup_optimizer_settings%ROWTYPE; v_changed boolean;
BEGIN
  IF p_game_date IS DISTINCT FROM (now() AT TIME ZONE 'America/New_York')::date THEN RETURN false; END IF;
  SELECT * INTO v_setting FROM public.lineup_optimizer_settings
  WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id FOR UPDATE;
  IF NOT FOUND OR NOT v_setting.enabled OR v_setting.last_daily_optimized_date = p_game_date THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.nba_games g JOIN public.league_seasons ls ON ls.season_year = g.season_year
    WHERE ls.id = p_league_season_id AND ls.is_current AND g.game_date = p_game_date
      AND g.status = 'Scheduled' AND private.lineup_game_available(g.status, g.game_status_text)
      AND (g.game_time IS NULL OR g.game_time > now())
      AND (g.started_at IS NULL OR g.started_at > now())
  ) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.lineup_tipoff_members
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id
      AND (tipoff_at AT TIME ZONE 'America/New_York')::date = p_game_date AND error IS NULL) THEN
    UPDATE public.lineup_optimizer_settings SET last_daily_optimized_date = p_game_date
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
    RETURN false;
  END IF;
  v_changed := private.apply_scheduled_lineup(p_game_date, p_league_id, p_league_season_id, p_member_id, p_assignments);
  UPDATE public.lineup_optimizer_settings SET last_daily_optimized_date = p_game_date, last_optimized_at = now()
  WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
  RETURN v_changed;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_lineup_optimizer(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_today date := (p_now AT TIME ZONE 'America/New_York')::date;
  v_midnight timestamptz := v_today::timestamp AT TIME ZONE 'America/New_York';
  v_due timestamptz;
BEGIN
  SELECT greatest(v_midnight, least((v_today + time '06:00') AT TIME ZONE 'America/New_York',
    min(g.game_time) - interval '10 minutes')) INTO v_due
  FROM public.nba_games g
  WHERE g.game_date = v_today AND g.status = 'Scheduled'
    AND private.lineup_game_available(g.status, g.game_status_text);
  IF p_now < v_due THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM public.nba_games g
    WHERE g.game_date = v_today AND g.status = 'Scheduled'
      AND private.lineup_game_available(g.status, g.game_status_text)
      AND (g.game_time IS NULL OR g.game_time > p_now)
      AND (g.started_at IS NULL OR g.started_at > p_now)
      AND EXISTS (
        SELECT 1 FROM public.lineup_optimizer_settings s
        JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
        JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
        WHERE s.enabled AND ls.season_year = g.season_year
          AND s.last_daily_optimized_date IS DISTINCT FROM v_today
      )
  ) THEN
    PERFORM private.work_enqueue('lineup-optimizer', v_today::text, p_now,
      jsonb_build_object('mode', 'daily', 'date', v_today));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
  v_trade record; v_waiver record; v_waiver_day date; v_waiver_due timestamptz;
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
  PERFORM private.enqueue_lineup_optimizer(p_now);
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  PERFORM private.enqueue_matchup_forecasts(p_now);
  PERFORM private.enqueue_screen_views(p_now);
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    IF ((p_now AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (p_now AT TIME ZONE 'America/New_York')::time<time '06:00') THEN
      PERFORM private.enqueue_daily('sync-players',4,0,p_now);
      PERFORM private.enqueue_daily('sync-trade-values',4,0,p_now);
      PERFORM private.enqueue_rankings(p_now);
      FOR v_trade IN SELECT DISTINCT queued.league_id,queued.league_season_id,queued.version
        FROM private.screen_refresh_queue queued JOIN public.trades trade ON trade.league_season_id=queued.league_season_id
        WHERE trade.status IN ('pending','accepted') LOOP
        PERFORM private.work_enqueue('trade-revaluation-scan',v_trade.league_season_id::text||':'||
          (p_now AT TIME ZONE 'America/New_York')::date::text,p_now,
          jsonb_build_object('revaluationScan',true,'leagueId',v_trade.league_id,'seasonId',v_trade.league_season_id,
            'version',v_trade.version),v_trade.league_id);
      END LOOP;
    END IF;
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

REVOKE ALL ON FUNCTION private.apply_scheduled_lineup(date,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_daily_lineup(date,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_daily_lineup(date,uuid,uuid,uuid,jsonb) TO service_role;
