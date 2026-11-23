ALTER TABLE private.work_kinds
  ADD COLUMN cadence interval CHECK (cadence IN (interval '1 hour', interval '1 day', interval '7 days')),
  ADD COLUMN due_offset interval CHECK (due_offset >= interval '0' AND due_offset < cadence),
  ADD COLUMN cadence_zone text CHECK (cadence_zone IN ('UTC', 'America/New_York')),
  ADD COLUMN schedule_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(schedule_payload) = 'object'),
  ADD COLUMN essential_level text NOT NULL DEFAULT 'none' CHECK (essential_level IN ('none', 'shed', 'paused')),
  ADD CONSTRAINT work_kinds_cadence_complete CHECK ((cadence IS NULL) = (due_offset IS NULL) AND (cadence IS NULL) = (cadence_zone IS NULL));

UPDATE private.work_kinds kinds SET cadence = schedule.cadence, due_offset = schedule.due_offset,
  cadence_zone = schedule.zone, schedule_payload = schedule.payload
FROM (VALUES
  ('sync-players', interval '1 day', interval '4 hours', 'America/New_York', '{}'::jsonb),
  ('sync-trade-values', interval '1 day', interval '4 hours', 'America/New_York', '{}'::jsonb),
  ('sync-schedule', interval '1 day', interval '6 hours 5 minutes', 'America/New_York', '{}'::jsonb),
  ('missing-final-stats', interval '1 day', interval '6 hours 30 minutes', 'America/New_York', '{}'::jsonb),
  ('cleanup-trade-estimates', interval '1 day', interval '8 hours 35 minutes', 'UTC', '{}'::jsonb),
  ('mock-room-expiry', interval '1 day', interval '9 hours 30 minutes', 'UTC', '{}'::jsonb),
  ('retention-prune', interval '1 day', interval '10 hours', 'UTC', '{}'::jsonb),
  ('public-read-retention', interval '1 hour', interval '17 minutes', 'UTC', '{}'::jsonb),
  ('pg-net-response-vacuum', interval '1 hour', interval '17 minutes', 'UTC', '{"action":"vacuum"}'::jsonb)
) AS schedule(kind, cadence, due_offset, zone, payload)
WHERE kinds.kind = schedule.kind;

UPDATE private.work_kinds SET essential_level = 'paused'
WHERE kind IN ('process-waivers', 'process-trades', 'live-poll', 'refresh-live-matchups', 'roster-floor');
UPDATE private.work_kinds SET essential_level = 'shed'
WHERE kind IN ('sync-scores', 'stats-sync', 'edge-invocation-reconcile');

DO $$
BEGIN
  IF (SELECT count(*) FROM private.work_kinds WHERE cadence IS NOT NULL) <> 9
    OR (SELECT count(*) FROM private.work_kinds WHERE essential_level <> 'none') <> 8 THEN
    RAISE EXCEPTION 'work_kinds schedule rows are incomplete';
  END IF;
END;
$$;

CREATE TABLE private.cron_dispatch_claims(
  job text PRIMARY KEY,
  period_start timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL
);
ALTER TABLE private.cron_dispatch_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.cron_dispatch_claims FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.claim_cron_dispatch(p_job text,p_every interval,p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH claimed AS (
    INSERT INTO private.cron_dispatch_claims AS claim(job,period_start,claimed_at)
    VALUES(p_job,date_bin(p_every,p_now,timestamptz '2000-01-03 00:00+00'),clock_timestamp())
    ON CONFLICT(job) DO UPDATE SET period_start=excluded.period_start,claimed_at=excluded.claimed_at
    WHERE claim.period_start IS DISTINCT FROM excluded.period_start
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM claimed);
$$;

CREATE OR REPLACE FUNCTION private.enqueue_cadenced_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind record; v_local timestamp; v_period timestamp;
BEGIN
  FOR v_kind IN SELECT kind,cadence,due_offset,cadence_zone,schedule_payload FROM private.work_kinds
    WHERE cadence IS NOT NULL AND retired_at IS NULL ORDER BY kind LOOP
    v_local:=p_now AT TIME ZONE v_kind.cadence_zone;
    v_period:=date_bin(v_kind.cadence,v_local,timestamp '2000-01-03 00:00');
    IF v_local>=v_period+v_kind.due_offset THEN
      PERFORM private.work_enqueue(v_kind.kind,
        CASE WHEN v_kind.cadence>=interval '1 day' THEN v_period::date::text ELSE v_period::text END,
        p_now,v_kind.schedule_payload);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_edge_invocation_reconcile(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE reconciled_at IS NULL OR worker_status='running') THEN RETURN; END IF;
  IF private.claim_cron_dispatch('edge-invocation-reconcile',interval '5 minutes',p_now) THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',date_bin(interval '5 minutes',p_now,timestamptz '2000-01-03 00:00+00')::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_trade record; v_waiver record; v_floor record; v_waiver_day date; v_waiver_due timestamptz;
  v_utc timestamp:=p_now AT TIME ZONE 'UTC';
BEGIN
  PERFORM private.enqueue_cadenced_work(p_now);
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
  IF private.claim_cron_dispatch('live-poll',interval '2 minutes',p_now) THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF private.claim_cron_dispatch('scheduled-quarter-hour',interval '15 minutes',p_now) THEN
    IF ((p_now AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (p_now AT TIME ZONE 'America/New_York')::time<time '06:00') THEN
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
    PERFORM private.enqueue_player_injuries(p_now);
    FOR v_waiver IN SELECT DISTINCT coalesce(timezone, 'America/Los_Angeles') AS timezone
      FROM public.leagues WHERE status IN ('active', 'playoffs', 'offseason') LOOP
      v_waiver_day := (p_now AT TIME ZONE v_waiver.timezone)::date;
      v_waiver_due := v_waiver_day::timestamp AT TIME ZONE v_waiver.timezone;
      PERFORM private.work_enqueue('process-waivers', v_waiver.timezone || ':' || v_waiver_day::text, v_waiver_due, jsonb_build_object('timezone', v_waiver.timezone, 'date', v_waiver_day));
    END LOOP;
    FOR v_floor IN
      SELECT policy.league_id, season.id AS season_id, weeks.week_end
        FROM private.league_roster_policies policy
        JOIN public.leagues league ON league.id = policy.league_id
          AND league.status IN ('active', 'playoffs')
        JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
        JOIN public.season_weeks weeks ON weeks.season_year = season.season_year
          AND weeks.week_end <= (p_now AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date
       WHERE policy.weekly_roster_floor IS NOT NULL
         AND policy.floor_activated_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.matchups matchup
            WHERE matchup.league_id = league.id
              AND matchup.league_season_id = season.id
              AND matchup.week_number = weeks.week_number
         )
         AND (weeks.week_end + time '00:00') AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles') <= p_now
         AND NOT EXISTS (
           SELECT 1 FROM private.roster_floor_weeks week_row
            WHERE week_row.league_id = policy.league_id
              AND week_row.league_season_id = season.id
              AND week_row.week_number = weeks.week_number
              AND week_row.status IN ('completed', 'expired')
         )
         AND (
           weeks.week_end = (
             SELECT max(latest.week_end)
               FROM public.season_weeks latest
              WHERE latest.season_year = season.season_year
                AND latest.week_end <= (p_now AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date
                AND EXISTS (
                  SELECT 1 FROM public.matchups matchup
                   WHERE matchup.league_id = league.id
                     AND matchup.league_season_id = season.id
                     AND matchup.week_number = latest.week_number
                )
           )
           OR EXISTS (
             SELECT 1 FROM private.roster_floor_weeks pending
              WHERE pending.league_id = policy.league_id
                AND pending.league_season_id = season.id
                AND pending.week_number = weeks.week_number
                AND pending.status = 'pending'
           )
         )
    LOOP
      PERFORM private.work_enqueue(
        'roster-floor',
        v_floor.league_id::text || ':' || v_floor.week_end::text || ':' || (extract(epoch FROM p_now) / 900)::bigint::text,
        p_now,
        jsonb_build_object('leagueId', v_floor.league_id, 'leagueSeasonId', v_floor.season_id,
          'weekEnd', v_floor.week_end, 'bucket', (extract(epoch FROM p_now) / 900)::bigint),
        v_floor.league_id
      );
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
  PERFORM private.enqueue_edge_invocation_reconcile(p_now);
  IF v_utc::time>=time '13:00' AND to_char(v_utc,'MM-DD') BETWEEN '06-20' AND '07-15' THEN
    PERFORM private.work_enqueue('sync-draft-order',v_utc::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp(); v_level text; v_kinds text[]; v_waiver record; v_floor record; v_day date;
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
    ELSE
      PERFORM private.enqueue_stats_sync_dispatch(now());
      PERFORM private.enqueue_edge_invocation_reconcile(now());
    END IF;
    v_kinds:=ARRAY(SELECT kind FROM private.work_kinds WHERE essential_level='paused' OR v_level='shed' AND essential_level='shed');
    PERFORM private.enqueue_process_trades(now());
    IF v_level='paused' OR private.claim_cron_dispatch('live-poll',interval '2 minutes',now()) THEN PERFORM private.enqueue_live_poll(now()); END IF;
    IF v_level='paused' OR private.claim_cron_dispatch('degraded-waivers',interval '15 minutes',now()) THEN
      FOR v_waiver IN SELECT DISTINCT coalesce(timezone,'America/Los_Angeles') AS timezone
        FROM public.leagues WHERE status IN ('active','playoffs','offseason') LOOP
        v_day:=(now() AT TIME ZONE v_waiver.timezone)::date;
        PERFORM private.work_enqueue('process-waivers',v_waiver.timezone||':'||v_day::text,
          v_day::timestamp AT TIME ZONE v_waiver.timezone,jsonb_build_object('timezone',v_waiver.timezone,'date',v_day));
      END LOOP;
    END IF;
    FOR v_floor IN
      SELECT policy.league_id, season.id AS season_id, weeks.week_end
        FROM private.league_roster_policies policy
        JOIN public.leagues league ON league.id = policy.league_id
          AND league.status IN ('active', 'playoffs')
        JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
        JOIN public.season_weeks weeks ON weeks.season_year = season.season_year
          AND weeks.week_end <= (now() AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date
       WHERE policy.weekly_roster_floor IS NOT NULL
         AND policy.floor_activated_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.matchups matchup
            WHERE matchup.league_id = league.id
              AND matchup.league_season_id = season.id
              AND matchup.week_number = weeks.week_number
         )
         AND (weeks.week_end + time '00:00') AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles') <= now()
         AND NOT EXISTS (
           SELECT 1 FROM private.roster_floor_weeks week_row
            WHERE week_row.league_id = policy.league_id
              AND week_row.league_season_id = season.id
              AND week_row.week_number = weeks.week_number
              AND week_row.status IN ('completed', 'expired')
         )
         AND (
           weeks.week_end = (
             SELECT max(latest.week_end)
               FROM public.season_weeks latest
              WHERE latest.season_year = season.season_year
                AND latest.week_end <= (now() AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date
                AND EXISTS (
                  SELECT 1 FROM public.matchups matchup
                   WHERE matchup.league_id = league.id
                     AND matchup.league_season_id = season.id
                     AND matchup.week_number = latest.week_number
                )
           )
           OR EXISTS (
             SELECT 1 FROM private.roster_floor_weeks pending
              WHERE pending.league_id = policy.league_id
                AND pending.league_season_id = season.id
                AND pending.week_number = weeks.week_number
                AND pending.status = 'pending'
           )
         )
    LOOP
      PERFORM private.work_enqueue(
        'roster-floor',
        v_floor.league_id::text || ':' || v_floor.week_end::text || ':' || (extract(epoch FROM now()) / 900)::bigint::text,
        now(),
        jsonb_build_object('leagueId', v_floor.league_id, 'leagueSeasonId', v_floor.season_id,
          'weekEnd', v_floor.week_end, 'bucket', (extract(epoch FROM now()) / 900)::bigint),
        v_floor.league_id
      );
    END LOOP;
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

REVOKE ALL ON FUNCTION private.claim_cron_dispatch(text,interval,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.enqueue_cadenced_work(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.enqueue_edge_invocation_reconcile(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
