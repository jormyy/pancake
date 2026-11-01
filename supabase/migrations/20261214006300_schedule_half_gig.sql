BEGIN;

ALTER TABLE private.screen_refresh_queue ADD COLUMN last_refreshed_at timestamptz,
  ADD COLUMN standings_dirty boolean NOT NULL DEFAULT true;
ALTER TABLE private.matchup_forecast_queue ADD COLUMN finalized boolean NOT NULL DEFAULT false;

CREATE VIEW private.matchup_forecast_schedule AS
SELECT matchup.id AS matchup_id,CASE WHEN matchup.is_finalized THEN CASE WHEN NOT COALESCE(queued.finalized,false) THEN now() END
    WHEN EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date BETWEEN first_week.week_start AND last_week.week_end AND game.status='InProgress')
      THEN GREATEST(now(),cached.calculated_at+interval '30 minutes')
    ELSE (SELECT min(game.game_time) FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date BETWEEN first_week.week_start AND last_week.week_end
      AND game.status NOT IN ('Final','Cancelled','Postponed') AND game.game_time>now()) END AS due_at
  FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year
    AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  LEFT JOIN public.matchup_forecasts cached ON cached.matchup_id=matchup.id
  LEFT JOIN private.matchup_forecast_queue queued ON queued.matchup_id=matchup.id
  WHERE NOT matchup.is_voided;
REVOKE ALL ON private.matchup_forecast_schedule FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.begin_trade_revaluation(p_trade_id uuid,p_model text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_model IS NULL OR NOT EXISTS(SELECT 1 FROM public.trades WHERE id=p_trade_id AND status IN ('pending','accepted')) THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM private.trade_revaluation_schedule WHERE trade_id=p_trade_id AND next_allowed_at>now());
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
    AND (SELECT due_at FROM private.matchup_forecast_schedule schedule WHERE schedule.matchup_id=private.matchup_forecast_queue.matchup_id)<=now()
    AND NOT private.matchup_forecast_refresh_pending(matchup_id)
    AND (claimed_at IS NULL OR claimed_at<now()-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',now())::text,now());
  END IF;
  RETURN jsonb_build_object('processed',processed,'remaining',EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now())
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=now()));
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=p_now)
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=p_now) THEN
    PERFORM private.work_enqueue('forecast-inputs',date_trunc('minute',p_now)::text,p_now,'{"schedulerChunk":"forecasts"}');
  END IF;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND (SELECT due_at FROM private.matchup_forecast_schedule schedule WHERE schedule.matchup_id=private.matchup_forecast_queue.matchup_id)<=p_now
    AND NOT private.matchup_forecast_refresh_pending(matchup_id)
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_player_injuries(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date;
  v_first_tipoff timestamptz; v_last_tipoff timestamptz; v_key text;
BEGIN
  SELECT min(game_time),max(game_time) INTO v_first_tipoff,v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND status NOT IN ('Cancelled','Postponed');
  IF v_first_tipoff IS NULL THEN
    IF (p_now AT TIME ZONE 'America/New_York')::time<time '08:00' THEN RETURN; END IF;
    v_key:=v_today::text;
  ELSIF p_now BETWEEN v_first_tipoff-interval '2 hours' AND v_last_tipoff THEN
    v_key:=date_bin(interval '15 minutes',p_now,timestamptz '2000-01-01 00:00 UTC')::text;
  ELSIF p_now<v_first_tipoff-interval '2 hours' THEN
    v_key:=date_trunc('hour',p_now)::text;
  ELSE RETURN;
  END IF;
  PERFORM private.work_enqueue('player-injuries',v_key,p_now);
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_rankings(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_local timestamp:=p_now AT TIME ZONE 'America/New_York'; v_view text;
BEGIN
  IF NOT ((p_now AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (p_now AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress')) THEN RETURN; END IF;
  FOREACH v_view IN ARRAY ARRAY['POINT_3','ROOKIE','POINT_5'] LOOP
    PERFORM private.work_enqueue('sync-rankings',v_local::date::text||':'||v_view,p_now,jsonb_build_object('view',v_view));
  END LOOP;
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
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  PERFORM private.enqueue_matchup_forecasts(p_now);
  PERFORM private.enqueue_screen_views(p_now);
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    IF ((p_now AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (p_now AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress')) THEN
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

CREATE OR REPLACE FUNCTION private.enqueue_trade_revaluation_scan(p_season_id uuid,p_version bigint,p_model text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_league uuid; source_version text; previous private.trade_revaluation_scans%ROWTYPE;
BEGIN
  SELECT league_id INTO selected_league FROM public.league_seasons WHERE id=p_season_id;
  IF NOT EXISTS(SELECT 1 FROM public.trades WHERE league_season_id=p_season_id AND status IN ('pending','accepted')) THEN
    DELETE FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
    RETURN false;
  END IF;
  IF p_model IS NOT NULL THEN
    source_version:=private.trade_revaluation_source_version(p_season_id);
    SELECT * INTO previous FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
    IF previous.source_version=source_version AND previous.model_version=p_model AND previous.next_change_at>now()
      AND NOT EXISTS(
        SELECT 1 FROM jsonb_each_text(previous.fingerprints) input
        WHERE NOT EXISTS(SELECT 1 FROM private.trade_value_publications published WHERE published.trade_id=input.key::uuid
          AND published.input_fingerprint=input.value AND published.model_version=p_model)
        AND NOT EXISTS(SELECT 1 FROM private.work_items work WHERE work.kind='trade-revaluation'
          AND work.key=input.key||':'||p_model||':latest' AND work.status IN ('pending','running','failed')
          AND work.payload->>'inputFingerprint'=input.value)
      ) THEN
      UPDATE private.trade_value_publications published SET version=queued.version,valid_until='infinity'
      FROM jsonb_each_text(previous.fingerprints) input JOIN public.trades trade ON trade.id=input.key::uuid
        JOIN private.screen_refresh_queue queued ON queued.league_season_id=trade.league_season_id
      WHERE published.trade_id=trade.id AND published.input_fingerprint=input.value
        AND published.model_version=p_model AND published.version<queued.version;
      RETURN false;
    END IF;
  END IF;
  RETURN private.work_enqueue('trade-revaluation-scan',p_season_id::text||':'||
    ((CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress') THEN now() ELSE private.trade_revaluation_next_change() END) AT TIME ZONE 'America/New_York')::date::text,(CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress') THEN now() ELSE private.trade_revaluation_next_change() END),
    jsonb_build_object('revaluationScan',true,'leagueId',selected_league,'seasonId',p_season_id,'version',p_version),selected_league) IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.enqueue_trade_revaluation_scan(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.maintain_player_season_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_player uuid; v_years integer[]; v_final boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM totals_new_rows) THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM totals_old_rows) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM totals_new_rows n FULL JOIN totals_old_rows o USING(id)
    WHERE n.id IS NULL OR o.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP='INSERT' THEN v_rows := 'SELECT n.*,1 AS sign FROM totals_new_rows n';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT o.*,-1 AS sign FROM totals_old_rows o';
  ELSE v_rows := $rows$SELECT n.*,1 AS sign FROM totals_new_rows n LEFT JOIN totals_old_rows o USING(id)
    WHERE o.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
    UNION ALL SELECT o.*,-1 AS sign FROM totals_old_rows o LEFT JOIN totals_new_rows n USING(id)
    WHERE n.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM ('||v_rows||') changed JOIN public.nba_games game ON game.id=changed.game_id WHERE game.status=''Final'')' INTO v_final;
  IF NOT v_final THEN RETURN NULL; END IF;
  FOR v_player IN EXECUTE 'SELECT DISTINCT player_id FROM ('||v_rows||') changed JOIN public.nba_games game ON game.id=changed.game_id WHERE game.status=''Final'' ORDER BY player_id' LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('player-season-totals:'||v_player::text,0));
  END LOOP;
  EXECUTE format($query$
    WITH changed AS (%s), grouped AS (
      SELECT s.player_id,s.season_year,s.sign,
      count(*)::bigint AS games_played,
      COALESCE(sum(s.minutes_played),0) AS minutes_played, count(s.minutes_played)::bigint AS minutes_played_count,
      COALESCE(sum(s.points),0) AS points, count(s.points)::bigint AS points_count,
      COALESCE(sum(s.rebounds),0) AS rebounds, count(s.rebounds)::bigint AS rebounds_count,
      COALESCE(sum(s.offensive_rebounds),0) AS offensive_rebounds, count(s.offensive_rebounds)::bigint AS offensive_rebounds_count,
      COALESCE(sum(s.defensive_rebounds),0) AS defensive_rebounds, count(s.defensive_rebounds)::bigint AS defensive_rebounds_count,
      COALESCE(sum(s.assists),0) AS assists, count(s.assists)::bigint AS assists_count,
      COALESCE(sum(s.steals),0) AS steals, count(s.steals)::bigint AS steals_count,
      COALESCE(sum(s.blocks),0) AS blocks, count(s.blocks)::bigint AS blocks_count,
      COALESCE(sum(s.turnovers),0) AS turnovers, count(s.turnovers)::bigint AS turnovers_count,
      COALESCE(sum(s.personal_fouls),0) AS personal_fouls, count(s.personal_fouls)::bigint AS personal_fouls_count,
      COALESCE(sum(s.field_goals_made),0) AS field_goals_made, count(s.field_goals_made)::bigint AS field_goals_made_count,
      COALESCE(sum(s.field_goals_attempted),0) AS field_goals_attempted, count(s.field_goals_attempted)::bigint AS field_goals_attempted_count,
      COALESCE(sum(s.three_pointers_made),0) AS three_pointers_made, count(s.three_pointers_made)::bigint AS three_pointers_made_count,
      COALESCE(sum(s.three_pointers_attempted),0) AS three_pointers_attempted, count(s.three_pointers_attempted)::bigint AS three_pointers_attempted_count,
      COALESCE(sum(s.free_throws_made),0) AS free_throws_made, count(s.free_throws_made)::bigint AS free_throws_made_count,
      COALESCE(sum(s.free_throws_attempted),0) AS free_throws_attempted, count(s.free_throws_attempted)::bigint AS free_throws_attempted_count,
      COALESCE(sum(s.plus_minus),0) AS plus_minus, count(s.plus_minus)::bigint AS plus_minus_count,
      count(*) FILTER(WHERE s.double_double)::bigint AS double_double,
      count(*) FILTER(WHERE s.triple_double)::bigint AS triple_double
      FROM changed s JOIN public.nba_games g ON g.id=s.game_id
      WHERE g.status='Final' AND NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id)
      GROUP BY s.player_id,s.season_year,s.sign
    ), delta AS (
      SELECT player_id,season_year,sign*games_played AS games_played,sign*minutes_played AS minutes_played,sign*minutes_played_count AS minutes_played_count,sign*points AS points,sign*points_count AS points_count,sign*rebounds AS rebounds,sign*rebounds_count AS rebounds_count,sign*offensive_rebounds AS offensive_rebounds,sign*offensive_rebounds_count AS offensive_rebounds_count,sign*defensive_rebounds AS defensive_rebounds,sign*defensive_rebounds_count AS defensive_rebounds_count,sign*assists AS assists,sign*assists_count AS assists_count,sign*steals AS steals,sign*steals_count AS steals_count,sign*blocks AS blocks,sign*blocks_count AS blocks_count,sign*turnovers AS turnovers,sign*turnovers_count AS turnovers_count,sign*personal_fouls AS personal_fouls,sign*personal_fouls_count AS personal_fouls_count,sign*field_goals_made AS field_goals_made,sign*field_goals_made_count AS field_goals_made_count,sign*field_goals_attempted AS field_goals_attempted,sign*field_goals_attempted_count AS field_goals_attempted_count,sign*three_pointers_made AS three_pointers_made,sign*three_pointers_made_count AS three_pointers_made_count,sign*three_pointers_attempted AS three_pointers_attempted,sign*three_pointers_attempted_count AS three_pointers_attempted_count,sign*free_throws_made AS free_throws_made,sign*free_throws_made_count AS free_throws_made_count,sign*free_throws_attempted AS free_throws_attempted,sign*free_throws_attempted_count AS free_throws_attempted_count,sign*plus_minus AS plus_minus,sign*plus_minus_count AS plus_minus_count,sign*double_double AS double_double,sign*triple_double AS triple_double FROM grouped
    ), combined AS (
      SELECT player_id,season_year,sum(games_played) AS games_played,sum(minutes_played) AS minutes_played,sum(minutes_played_count) AS minutes_played_count,sum(points) AS points,sum(points_count) AS points_count,sum(rebounds) AS rebounds,sum(rebounds_count) AS rebounds_count,sum(offensive_rebounds) AS offensive_rebounds,sum(offensive_rebounds_count) AS offensive_rebounds_count,sum(defensive_rebounds) AS defensive_rebounds,sum(defensive_rebounds_count) AS defensive_rebounds_count,sum(assists) AS assists,sum(assists_count) AS assists_count,sum(steals) AS steals,sum(steals_count) AS steals_count,sum(blocks) AS blocks,sum(blocks_count) AS blocks_count,sum(turnovers) AS turnovers,sum(turnovers_count) AS turnovers_count,sum(personal_fouls) AS personal_fouls,sum(personal_fouls_count) AS personal_fouls_count,sum(field_goals_made) AS field_goals_made,sum(field_goals_made_count) AS field_goals_made_count,sum(field_goals_attempted) AS field_goals_attempted,sum(field_goals_attempted_count) AS field_goals_attempted_count,sum(three_pointers_made) AS three_pointers_made,sum(three_pointers_made_count) AS three_pointers_made_count,sum(three_pointers_attempted) AS three_pointers_attempted,sum(three_pointers_attempted_count) AS three_pointers_attempted_count,sum(free_throws_made) AS free_throws_made,sum(free_throws_made_count) AS free_throws_made_count,sum(free_throws_attempted) AS free_throws_attempted,sum(free_throws_attempted_count) AS free_throws_attempted_count,sum(plus_minus) AS plus_minus,sum(plus_minus_count) AS plus_minus_count,sum(double_double) AS double_double,sum(triple_double) AS triple_double FROM delta GROUP BY player_id,season_year
    )
    INSERT INTO analytics.player_season_totals AS stored(player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double)
      SELECT player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double FROM combined
      WHERE games_played<>0 OR (combined.minutes_played,combined.minutes_played_count,combined.points,combined.points_count,combined.rebounds,combined.rebounds_count,combined.offensive_rebounds,combined.offensive_rebounds_count,combined.defensive_rebounds,combined.defensive_rebounds_count,combined.assists,combined.assists_count,combined.steals,combined.steals_count,combined.blocks,combined.blocks_count,combined.turnovers,combined.turnovers_count,combined.personal_fouls,combined.personal_fouls_count,combined.field_goals_made,combined.field_goals_made_count,combined.field_goals_attempted,combined.field_goals_attempted_count,combined.three_pointers_made,combined.three_pointers_made_count,combined.three_pointers_attempted,combined.three_pointers_attempted_count,combined.free_throws_made,combined.free_throws_made_count,combined.free_throws_attempted,combined.free_throws_attempted_count,combined.plus_minus,combined.plus_minus_count,combined.double_double,combined.triple_double) IS DISTINCT FROM (0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)
      ORDER BY player_id,season_year
    ON CONFLICT(player_id,season_year) DO UPDATE SET
      games_played=stored.games_played+EXCLUDED.games_played,
      minutes_played=stored.minutes_played+EXCLUDED.minutes_played,
      minutes_played_count=stored.minutes_played_count+EXCLUDED.minutes_played_count,
      points=stored.points+EXCLUDED.points,
      points_count=stored.points_count+EXCLUDED.points_count,
      rebounds=stored.rebounds+EXCLUDED.rebounds,
      rebounds_count=stored.rebounds_count+EXCLUDED.rebounds_count,
      offensive_rebounds=stored.offensive_rebounds+EXCLUDED.offensive_rebounds,
      offensive_rebounds_count=stored.offensive_rebounds_count+EXCLUDED.offensive_rebounds_count,
      defensive_rebounds=stored.defensive_rebounds+EXCLUDED.defensive_rebounds,
      defensive_rebounds_count=stored.defensive_rebounds_count+EXCLUDED.defensive_rebounds_count,
      assists=stored.assists+EXCLUDED.assists,
      assists_count=stored.assists_count+EXCLUDED.assists_count,
      steals=stored.steals+EXCLUDED.steals,
      steals_count=stored.steals_count+EXCLUDED.steals_count,
      blocks=stored.blocks+EXCLUDED.blocks,
      blocks_count=stored.blocks_count+EXCLUDED.blocks_count,
      turnovers=stored.turnovers+EXCLUDED.turnovers,
      turnovers_count=stored.turnovers_count+EXCLUDED.turnovers_count,
      personal_fouls=stored.personal_fouls+EXCLUDED.personal_fouls,
      personal_fouls_count=stored.personal_fouls_count+EXCLUDED.personal_fouls_count,
      field_goals_made=stored.field_goals_made+EXCLUDED.field_goals_made,
      field_goals_made_count=stored.field_goals_made_count+EXCLUDED.field_goals_made_count,
      field_goals_attempted=stored.field_goals_attempted+EXCLUDED.field_goals_attempted,
      field_goals_attempted_count=stored.field_goals_attempted_count+EXCLUDED.field_goals_attempted_count,
      three_pointers_made=stored.three_pointers_made+EXCLUDED.three_pointers_made,
      three_pointers_made_count=stored.three_pointers_made_count+EXCLUDED.three_pointers_made_count,
      three_pointers_attempted=stored.three_pointers_attempted+EXCLUDED.three_pointers_attempted,
      three_pointers_attempted_count=stored.three_pointers_attempted_count+EXCLUDED.three_pointers_attempted_count,
      free_throws_made=stored.free_throws_made+EXCLUDED.free_throws_made,
      free_throws_made_count=stored.free_throws_made_count+EXCLUDED.free_throws_made_count,
      free_throws_attempted=stored.free_throws_attempted+EXCLUDED.free_throws_attempted,
      free_throws_attempted_count=stored.free_throws_attempted_count+EXCLUDED.free_throws_attempted_count,
      plus_minus=stored.plus_minus+EXCLUDED.plus_minus,
      plus_minus_count=stored.plus_minus_count+EXCLUDED.plus_minus_count,
      double_double=stored.double_double+EXCLUDED.double_double,
      triple_double=stored.triple_double+EXCLUDED.triple_double
  $query$,v_rows);
  EXECUTE 'SELECT array_agg(DISTINCT season_year) FROM ('||v_rows||') changed' INTO v_years;
  EXECUTE 'DELETE FROM analytics.player_season_totals WHERE games_played=0 AND player_id IN (SELECT player_id FROM ('||v_rows||') changed)';
  PERFORM private.emit_player_stats_hint(v_years);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.matchup_forecast_input_fingerprint(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.id,m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,m.home_points,m.away_points,m.is_finalized,
    s.season_year,m.week_number,COALESCE(m.end_week_number,m.week_number) AS end_week_number,w.week_start,e.week_end,l.scoring_settings,
    (now() AT TIME ZONE 'America/New_York')::date AS today
  FROM public.matchups m JOIN public.leagues l ON l.id=m.league_id
  JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
  JOIN public.season_weeks e ON e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
  WHERE m.id=p_matchup_id AND NOT m.is_voided
), roster AS MATERIALIZED (
  SELECT r.member_id,r.player_id,r.is_on_ir,r.is_on_taxi,p.nba_team,p.eligible_positions,p.injury_status
  FROM context c JOIN public.roster_players r ON r.league_id=c.league_id AND r.league_season_id=c.league_season_id
    AND r.member_id IN(c.home_member_id,c.away_member_id)
  JOIN public.players p ON p.id=r.player_id
), games AS MATERIALIZED (
  SELECT g.id,g.game_date,g.home_team,g.away_team,g.status,g.game_time,g.started_at,
    g.live_scoreboard_elapsed_seconds,g.live_stats_elapsed_seconds
  FROM context c JOIN public.nba_games g ON g.season_year=c.season_year
    AND g.game_date BETWEEN c.week_start AND c.week_end
  WHERE public.is_regular_season_game_id(g.nba_game_id)
), freshness AS MATERIALIZED (
  SELECT 'sleeper' AS source,r.id::text AS id,r.fetched_at+interval '36 hours' AS expires
  FROM context c JOIN public.sleeper_projection_rows r ON r.season_year=c.season_year
    AND r.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
  WHERE r.player_id IN(SELECT player_id FROM roster)
  UNION ALL
  SELECT 'fantasypros',r.id::text,r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END
  FROM context c JOIN public.fantasypros_projection_rows r
    ON r.projection_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
      OR r.season_year=c.season_year AND r.projection_type<>'daily'
        AND (r.week_number IS NULL OR r.week_number BETWEEN c.week_number AND c.end_week_number)
  JOIN public.projection_sync_runs run ON run.id=r.run_id AND run.source='fantasypros'
    AND run.status='success' AND run.completed_at IS NOT NULL
  WHERE r.match_status='matched' AND r.player_id IN(SELECT player_id FROM roster)
)
SELECT jsonb_build_object(
  'inputs',md5(jsonb_build_object(
    'context',to_jsonb(c),
    'revisions',(SELECT jsonb_object_agg(kind,revision) FROM private.forecast_input_revisions WHERE kind IN('source','history')),
    'roster',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.player_id) FROM roster r),
    'games',(SELECT jsonb_agg(jsonb_build_array(g.id,g.game_date,g.home_team,g.away_team,g.status,g.game_time,g.started_at,
      COALESCE(g.game_time<=now(),false) OR COALESCE(g.started_at<=now(),false)) ORDER BY g.game_date,g.id) FROM games g),
    'stats',(SELECT jsonb_agg(to_jsonb(s)-ARRAY['updated_at','created_at','fetched_at'] ORDER BY s.game_id,s.player_id)
      FROM public.player_game_stats s JOIN games g ON g.id=s.game_id WHERE s.player_id IN(SELECT player_id FROM roster)),
    'lineups',(SELECT jsonb_agg(jsonb_build_array(l.member_id,l.player_id,l.game_date,l.slot_type,l.is_auto_set)
      ORDER BY l.game_date,l.member_id,l.player_id) FROM public.weekly_lineups l
      WHERE l.league_season_id=c.league_season_id AND l.member_id IN(c.home_member_id,c.away_member_id)
        AND l.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end),
    'templates',(SELECT jsonb_agg(jsonb_build_array(t.slot_type,t.slot_count) ORDER BY t.slot_type)
      FROM public.lineup_slot_templates t WHERE t.league_id=c.league_id AND t.slot_type NOT IN('BE','IR')),
    'automaticMembers',(SELECT jsonb_agg(s.member_id ORDER BY s.member_id) FROM public.lineup_optimizer_settings s
      WHERE s.league_season_id=c.league_season_id AND s.member_id IN(c.home_member_id,c.away_member_id) AND s.enabled),
    'freshness',(SELECT jsonb_agg(jsonb_build_array(f.source,f.id,f.expires>=now()) ORDER BY f.source,f.id) FROM freshness f)
  )::text),
  'clock',md5(COALESCE((SELECT jsonb_agg(jsonb_build_array(g.id,g.live_scoreboard_elapsed_seconds,g.live_stats_elapsed_seconds)
    ORDER BY g.id) FROM games g WHERE g.status='InProgress'
      AND EXISTS(SELECT 1 FROM roster r WHERE r.nba_team IN(g.home_team,g.away_team)))::text,'')),
  'validUntil',LEAST(now()+interval '30 minutes',(c.today+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(g.game_time) FROM games g WHERE g.game_time>now()),
    (SELECT min(g.started_at) FROM games g WHERE g.started_at>now()),
    (SELECT min(f.expires) FROM freshness f WHERE f.expires>=now()))
) FROM context c;
$$;

CREATE OR REPLACE FUNCTION private.projection_sync_due_work(p_now timestamptz DEFAULT now())
RETURNS TABLE(job_key text, period_key text, function_name text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH clock AS (
    SELECT (p_now AT TIME ZONE 'America/Los_Angeles')::date AS today,
      (p_now AT TIME ZONE 'America/Los_Angeles')::time AS local_time,
      date_trunc('week',p_now AT TIME ZONE 'America/Los_Angeles')::date AS monday,
      extract(year FROM p_now AT TIME ZONE 'America/Los_Angeles')::integer
        +(extract(month FROM p_now AT TIME ZONE 'America/Los_Angeles')>=10)::integer AS season_year
  ), calendar AS (
    SELECT clock.*,min(game.game_time) AS first_tipoff FROM clock
    LEFT JOIN public.nba_games game ON game.game_date=clock.today AND game.season_year=clock.season_year
      AND game.status NOT IN ('Cancelled','Postponed') AND public.is_regular_season_game_id(game.nba_game_id)
    GROUP BY today,local_time,monday,clock.season_year
  ), periods AS (
    SELECT *,today::text||CASE WHEN p_now>=first_tipoff-interval '1 hour' THEN ':pregame' ELSE ':08' END AS period
    FROM calendar WHERE (local_time>=time '08:00' AND local_time<time '09:00' AND (first_tipoff IS NULL OR p_now<first_tipoff))
      OR p_now>=first_tipoff-interval '1 hour' AND p_now<first_tipoff
  )
  SELECT 'pt:sleeper-day',period,'sync-sleeper-projections' FROM periods
    WHERE EXISTS(SELECT 1 FROM public.season_weeks week WHERE week.season_year=periods.season_year
      AND date_trunc('week',week.week_start::timestamp)::date=periods.monday)
  UNION ALL
  SELECT 'pt:fantasypros',period,'sync-projections' FROM periods;
$$;

CREATE OR REPLACE FUNCTION private.queue_changed_matchup_forecasts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected_league uuid;
BEGIN
  IF TG_TABLE_NAME='matchups' THEN
    IF TG_OP='UPDATE' AND NEW.is_finalized AND
      (NEW.is_finalized,NEW.home_points,NEW.away_points) IS DISTINCT FROM (OLD.is_finalized,OLD.home_points,OLD.away_points) THEN
      UPDATE private.matchup_forecast_queue SET finalized=false WHERE matchup_id=NEW.id AND finalized;
    END IF;
    PERFORM private.queue_matchup_forecasts(NEW.league_id,NEW.id);
  ELSIF TG_TABLE_NAME IN ('lineup_optimizer_settings','lineup_slot_templates') THEN
    IF TG_OP='DELETE' THEN PERFORM private.queue_matchup_forecasts(OLD.league_id);
    ELSE PERFORM private.queue_matchup_forecasts(NEW.league_id); END IF;
  ELSIF TG_TABLE_NAME='players' THEN
    FOR affected_league IN SELECT DISTINCT roster.league_id FROM public.roster_players roster
      WHERE roster.player_id=NEW.id ORDER BY roster.league_id LOOP
      PERFORM private.queue_matchup_forecasts(affected_league);
    END LOOP;
  ELSIF NEW.topic IN ('lineup','roster','score')
    OR NEW.topic='inventory' AND (NEW.details IS NULL OR NEW.details @> '[{"resource":"season"}]'::jsonb) THEN
    PERFORM private.queue_matchup_forecasts(NEW.league_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.queue_matchup_forecast_expiry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.matchups WHERE id=NEW.matchup_id AND is_finalized) THEN
    DELETE FROM private.matchup_forecast_expiries WHERE matchup_id=NEW.matchup_id;
    RETURN NULL;
  END IF;
  INSERT INTO private.matchup_forecast_expiries AS queued(matchup_id,available_at)
    VALUES(NEW.matchup_id,NEW.valid_until)
  ON CONFLICT(matchup_id) DO UPDATE SET available_at=EXCLUDED.available_at
    WHERE queued.available_at IS DISTINCT FROM EXCLUDED.available_at;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL,p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  INSERT INTO private.forecast_refresh_requests AS requested(scope,league_id,matchup_id,available_at)
  SELECT CASE WHEN p_matchup_id IS NOT NULL THEN 'matchup:'||p_matchup_id
    WHEN p_league_id IS NOT NULL THEN 'league:'||p_league_id ELSE 'all' END,p_league_id,p_matchup_id,min(due.due_at)
  FROM public.matchups matchup
  JOIN private.matchup_forecast_schedule due ON due.matchup_id=matchup.id
  WHERE (p_league_id IS NULL OR matchup.league_id=p_league_id)
    AND (p_matchup_id IS NULL OR matchup.id=p_matchup_id)
  HAVING min(due.due_at) IS NOT NULL
  ON CONFLICT(scope) DO UPDATE SET revision=requested.revision+1,after_matchup_id=NULL,available_at=EXCLUDED.available_at
    WHERE requested.available_at>EXCLUDED.available_at;
$$;

CREATE OR REPLACE FUNCTION private.rebuild_game_player_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player uuid;
BEGIN
  IF (OLD.status='Final')=(NEW.status='Final') AND OLD.season_year=NEW.season_year
    AND public.is_regular_season_game_id(OLD.nba_game_id) IS NOT DISTINCT FROM public.is_regular_season_game_id(NEW.nba_game_id) THEN RETURN NEW; END IF;
  FOR v_player IN SELECT DISTINCT player_id FROM public.player_game_stats WHERE game_id=NEW.id ORDER BY player_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('player-season-totals:'||v_player::text,0));
    DELETE FROM analytics.player_season_totals WHERE player_id=v_player AND season_year IN (OLD.season_year,NEW.season_year);
    INSERT INTO analytics.player_season_totals(player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double)
    SELECT s.player_id,s.season_year,count(*)::bigint AS games_played,
      COALESCE(sum(s.minutes_played),0) AS minutes_played, count(s.minutes_played)::bigint AS minutes_played_count,
      COALESCE(sum(s.points),0) AS points, count(s.points)::bigint AS points_count,
      COALESCE(sum(s.rebounds),0) AS rebounds, count(s.rebounds)::bigint AS rebounds_count,
      COALESCE(sum(s.offensive_rebounds),0) AS offensive_rebounds, count(s.offensive_rebounds)::bigint AS offensive_rebounds_count,
      COALESCE(sum(s.defensive_rebounds),0) AS defensive_rebounds, count(s.defensive_rebounds)::bigint AS defensive_rebounds_count,
      COALESCE(sum(s.assists),0) AS assists, count(s.assists)::bigint AS assists_count,
      COALESCE(sum(s.steals),0) AS steals, count(s.steals)::bigint AS steals_count,
      COALESCE(sum(s.blocks),0) AS blocks, count(s.blocks)::bigint AS blocks_count,
      COALESCE(sum(s.turnovers),0) AS turnovers, count(s.turnovers)::bigint AS turnovers_count,
      COALESCE(sum(s.personal_fouls),0) AS personal_fouls, count(s.personal_fouls)::bigint AS personal_fouls_count,
      COALESCE(sum(s.field_goals_made),0) AS field_goals_made, count(s.field_goals_made)::bigint AS field_goals_made_count,
      COALESCE(sum(s.field_goals_attempted),0) AS field_goals_attempted, count(s.field_goals_attempted)::bigint AS field_goals_attempted_count,
      COALESCE(sum(s.three_pointers_made),0) AS three_pointers_made, count(s.three_pointers_made)::bigint AS three_pointers_made_count,
      COALESCE(sum(s.three_pointers_attempted),0) AS three_pointers_attempted, count(s.three_pointers_attempted)::bigint AS three_pointers_attempted_count,
      COALESCE(sum(s.free_throws_made),0) AS free_throws_made, count(s.free_throws_made)::bigint AS free_throws_made_count,
      COALESCE(sum(s.free_throws_attempted),0) AS free_throws_attempted, count(s.free_throws_attempted)::bigint AS free_throws_attempted_count,
      COALESCE(sum(s.plus_minus),0) AS plus_minus, count(s.plus_minus)::bigint AS plus_minus_count,
      count(*) FILTER(WHERE s.double_double)::bigint AS double_double,
      count(*) FILTER(WHERE s.triple_double)::bigint AS triple_double
    FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
    WHERE s.player_id=v_player AND s.season_year IN (OLD.season_year,NEW.season_year)
      AND g.status='Final' AND NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id)
    GROUP BY s.player_id,s.season_year;
  END LOOP;
  PERFORM private.emit_player_stats_hint(ARRAY[OLD.season_year,NEW.season_year]);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_changed_screen_views()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['updated_at','set_at']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['updated_at','set_at']) THEN RETURN NULL; END IF;
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='trades' AND TG_OP='INSERT' AND row_data->>'status' IN ('pending','accepted') THEN
    PERFORM private.work_enqueue('trade-revaluation',NEW.id::text||':created',now(),
      jsonb_build_object('tradeId',NEW.id,'memberId',NEW.proposer_member_id,
        'userId',(SELECT user_id FROM public.league_members WHERE id=NEW.proposer_member_id),'latestInputs',true),NEW.league_id);
  END IF;
  IF TG_TABLE_NAME='league_seasons' AND TG_OP='UPDATE'
    AND to_jsonb(OLD)->>'season_year' IS DISTINCT FROM row_data->>'season_year' THEN
    UPDATE private.screen_refresh_queue SET averages_initialized=false WHERE league_season_id=(row_data->>'id')::uuid;
  END IF;
  IF TG_TABLE_NAME='league_change_hints' AND row_data->>'topic'='inventory'
    AND EXISTS(SELECT 1 FROM private.league_version_pending
      WHERE transaction_id=pg_current_xact_id() AND league_id=(row_data->>'league_id')::uuid) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME<>'league_change_hints' AND current_setting('pancake.trade_write',true)='true' THEN
    PERFORM private.queue_trade_publication(
      CASE WHEN TG_TABLE_NAME='leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'league_change_hints' AND row_data->>'topic' = 'version'
    AND jsonb_array_length(COALESCE(row_data->'details'->0->'scope'->'tables', '[]')) > 0
    AND row_data->'details'->0->'scope'->'tables' <@ '["standings_current","matchup_totals","player_season_averages","trade_value_cache","matchup_forecasts","league_events"]'::jsonb THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME IN ('league_members','league_seasons') OR TG_TABLE_NAME='matchups' AND (
    COALESCE((row_data->>'is_finalized')::boolean,false)
    OR TG_OP='UPDATE' AND COALESCE((to_jsonb(OLD)->>'is_finalized')::boolean,false)) THEN
    UPDATE private.screen_refresh_queue SET standings_dirty=true
      WHERE league_id=(row_data->>'league_id')::uuid AND NOT standings_dirty;
  END IF;
  PERFORM private.refresh_queue_screen_views(
    CASE WHEN TG_TABLE_NAME = 'leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_matchup_forecast_input(p_matchup_id uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE due timestamptz;
BEGIN
  due:=(SELECT due_at FROM private.matchup_forecast_schedule WHERE matchup_id=p_matchup_id);
  IF due IS NULL OR due>now() THEN RETURN due; END IF;
  INSERT INTO private.matchup_forecast_queue AS queued(matchup_id, revision, changed_at, dirty, input_fingerprint)
  SELECT matchup.id, 1, transaction_timestamp(), true,private.matchup_forecast_input_fingerprint(matchup.id)
  FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided
    AND (p_matchup_id IS NULL OR matchup.id=p_matchup_id)
    AND last_week.week_end >= (now() AT TIME ZONE 'America/New_York')::date - 1
    AND first_week.week_start <= (now() AT TIME ZONE 'America/New_York')::date + 14
  ORDER BY matchup.id
  ON CONFLICT(matchup_id) DO UPDATE SET
    revision=queued.revision+CASE WHEN (queued.input_fingerprint->>'inputs',queued.input_fingerprint->>'clock') IS DISTINCT FROM
      (EXCLUDED.input_fingerprint->>'inputs',EXCLUDED.input_fingerprint->>'clock') THEN 1 ELSE 0 END,
    changed_at=CASE WHEN (queued.input_fingerprint->>'inputs',queued.input_fingerprint->>'clock') IS DISTINCT FROM
      (EXCLUDED.input_fingerprint->>'inputs',EXCLUDED.input_fingerprint->>'clock') THEN transaction_timestamp() ELSE queued.changed_at END,
    dirty=(queued.computed_fingerprint->>'inputs',queued.computed_fingerprint->>'clock') IS DISTINCT FROM
      (EXCLUDED.input_fingerprint->>'inputs',EXCLUDED.input_fingerprint->>'clock'),
    available_at=CASE WHEN (queued.input_fingerprint->>'inputs',queued.input_fingerprint->>'clock') IS DISTINCT FROM
      (EXCLUDED.input_fingerprint->>'inputs',EXCLUDED.input_fingerprint->>'clock') THEN now() ELSE queued.available_at END,
    input_fingerprint=EXCLUDED.input_fingerprint
  WHERE (queued.input_fingerprint->>'inputs',queued.input_fingerprint->>'clock') IS DISTINCT FROM
      (EXCLUDED.input_fingerprint->>'inputs',EXCLUDED.input_fingerprint->>'clock')
    OR (queued.input_fingerprint->>'validUntil')::timestamptz<=now();
  UPDATE public.matchup_forecasts cached SET valid_until=GREATEST((queued.input_fingerprint->>'validUntil')::timestamptz,now()+interval '1 second')
  FROM private.matchup_forecast_queue queued WHERE cached.matchup_id=queued.matchup_id
    AND NOT queued.dirty AND cached.valid_until<=now()
    AND (p_matchup_id IS NULL OR cached.matchup_id=p_matchup_id);
  SELECT (input_fingerprint->>'validUntil')::timestamptz INTO due FROM private.matchup_forecast_queue WHERE matchup_id=p_matchup_id;
  RETURN due;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_queue_screen_views(p_league_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.screen_refresh_queue AS queued(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  WHERE p_league_id IS NULL OR season.league_id = p_league_id
  ORDER BY season.id
  ON CONFLICT (league_season_id) DO UPDATE SET version = queued.version + 1,
    dirty = true, changed_at = now(), available_at = GREATEST(COALESCE(queued.last_refreshed_at,'-infinity'::timestamptz)+interval '2 minutes',now())
  WHERE NOT queued.dirty OR queued.claimed_at IS NOT NULL AND queued.changed_at IS DISTINCT FROM now();
$$;

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluation(p_trade_id uuid,p_fingerprint text,p_model text,p_inputs jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade record; work_key text; work_payload jsonb; existing private.work_items%ROWTYPE; due timestamptz; queued_id bigint;
BEGIN
  SELECT t.*,m.user_id,q.version AS screen_version INTO trade FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
    JOIN private.screen_refresh_queue q ON q.league_season_id=t.league_season_id
    WHERE t.id=p_trade_id AND t.status IN ('pending','accepted');
  IF NOT FOUND OR p_fingerprint IS NULL OR p_model IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id
    AND input_fingerprint=p_fingerprint AND model_version=p_model) THEN
    UPDATE private.trade_value_publications SET version=GREATEST(version,trade.screen_version),valid_until='infinity'
      WHERE trade_id=trade.id AND version<trade.screen_version;
    RETURN false;
  END IF;
  due:=now();
  SELECT GREATEST(now(),next_allowed_at) INTO due FROM private.trade_revaluation_schedule WHERE trade_id=trade.id;
  IF due IS NULL THEN
    due:=CASE WHEN EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id)
      THEN (CASE WHEN (now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress') THEN now() ELSE private.trade_revaluation_next_change() END) ELSE now() END;
  END IF;
  work_key:=trade.id::text||':'||p_model||':latest';
  work_payload:=jsonb_build_object('tradeId',trade.id,'memberId',trade.proposer_member_id,'userId',trade.user_id,
    'inputFingerprint',p_fingerprint,'modelVersion',p_model,'latestInputs',true);
  SELECT * INTO existing FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    IF existing.status='running' THEN RETURN false; END IF;
    UPDATE private.work_items SET status='pending',attempts=CASE WHEN existing.status IN ('succeeded','dead') THEN 0 ELSE attempts END,
      due_at=CASE WHEN existing.status IN ('pending','failed') THEN LEAST(existing.due_at,due) ELSE due END,
      completed_at=NULL,payload=work_payload,last_error=NULL,invocation_key=NULL
      WHERE id=existing.id;
    RETURN true;
  END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key) THEN RETURN false; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    VALUES('trade-revaluation',work_key,due,work_payload,trade.league_id) ON CONFLICT DO NOTHING RETURNING id INTO queued_id;
  RETURN queued_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_trade_values(p_league_id uuid, p_season_id uuid, p_version bigint, p_values jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE item jsonb; trade record; inputs jsonb; value jsonb; published boolean:=false;
BEGIN
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Trade values must be an array.' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_values) LOOP
    SELECT t.*,m.user_id INTO trade FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
      WHERE t.id=(item->>'tradeId')::uuid AND t.league_id=p_league_id AND t.league_season_id=p_season_id
        AND t.status IN ('pending','accepted') FOR UPDATE OF t;
    IF NOT FOUND THEN CONTINUE; END IF;
    value:=item->'revaluation';
    IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'inputVersion' IS NULL
      OR value->>'modelVersion' IS NULL THEN CONTINUE; END IF;
    inputs:=jsonb_build_object('inputVersion',private.trade_revaluation_input_version(trade.id));
    IF inputs->>'inputVersion' IS DISTINCT FROM value->>'inputVersion' THEN
      PERFORM private.refresh_queue_trade_revaluation(trade.id,inputs->>'inputVersion',value->>'modelVersion');
      CONTINUE;
    END IF;
    INSERT INTO private.trade_revaluation_schedule AS schedule(trade_id,model_version,next_allowed_at)
      VALUES(trade.id,value->>'modelVersion',private.trade_revaluation_next_change())
    ON CONFLICT(trade_id) DO UPDATE SET model_version=EXCLUDED.model_version,next_allowed_at=EXCLUDED.next_allowed_at;
    IF EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id
      AND input_fingerprint=value->>'inputVersion' AND model_version=value->>'modelVersion') THEN
      published:=true;
      CONTINUE;
    END IF;
    INSERT INTO public.trade_value_cache AS cached(trade_id,league_id,league_season_id,revaluation,valid_until,version)
      VALUES(trade.id,p_league_id,p_season_id,value,'infinity',p_version)
      ON CONFLICT(trade_id) DO UPDATE SET revaluation=EXCLUDED.revaluation,valid_until=EXCLUDED.valid_until,
        version=EXCLUDED.version,refreshed_at=now();
    INSERT INTO private.trade_value_publications(trade_id,version,valid_until,input_fingerprint,model_version)
      VALUES(trade.id,p_version,'infinity',value->>'inputVersion',value->>'modelVersion')
      ON CONFLICT(trade_id) DO UPDATE SET version=EXCLUDED.version,valid_until=EXCLUDED.valid_until,
        input_fingerprint=EXCLUDED.input_fingerprint,model_version=EXCLUDED.model_version;
    published:=true;
  END LOOP;
  RETURN published;
END;
$$;

CREATE OR REPLACE FUNCTION private.trade_revaluation_next_change()
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT ((now() AT TIME ZONE 'America/New_York')::date
    +CASE WHEN (now() AT TIME ZONE 'America/New_York')::time<time '04:00' THEN 0 ELSE 1 END
    +time '04:00') AT TIME ZONE 'America/New_York';
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_next_change() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz; v_chunk jsonb; v_claim jsonb; v_started timestamptz;
  v_previous text:=coalesce(current_setting('pancake.work_id',true),'');
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE id=p_id AND lease_token=p_token AND status='running' AND lease_until>now();
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM private.work_kinds WHERE kind=v_item.kind AND retired_at IS NOT NULL) THEN
    UPDATE private.work_items SET status='dead',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
      invocation_key=NULL,last_error='Work kind is retired' WHERE id=p_id AND lease_token=p_token;
    RETURN;
  END IF;
  SELECT function_name INTO v_function FROM private.work_kinds WHERE kind=v_item.kind;
  v_payload:=v_item.payload;
  IF v_item.kind='trade-revaluation' THEN
    v_payload:=(v_payload-'inputs')||'{"latestInputs":true}'::jsonb;
  END IF;
  IF v_item.kind IN ('sync-players','sync-trade-values','sync-rankings','trade-revaluation-scan','trade-revaluation-check')
    AND NOT ((now() AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (now() AT TIME ZONE 'America/New_York')::time<time '06:00' AND NOT EXISTS(SELECT 1 FROM public.nba_games WHERE status='InProgress')) THEN
    UPDATE private.work_items SET status='pending',due_at=private.trade_revaluation_next_change(),
      lease_token=NULL,lease_until=NULL,invocation_key=NULL WHERE id=p_id AND lease_token=p_token;
    RETURN;
  END IF;
  IF v_item.kind IN ('forecast-inputs','refresh-views') THEN v_function:=NULL; END IF;
  IF v_item.kind='forecast-inputs' THEN
    v_started:=clock_timestamp();
    LOOP
      v_chunk:=private.complete_forecast_input_chunk();
      EXIT WHEN NOT (v_chunk->>'remaining')::boolean OR clock_timestamp()-v_started>=interval '1 second';
    END LOOP;
    PERFORM private.work_finish(p_id,p_token);
    IF (v_chunk->>'remaining')::boolean THEN
      PERFORM private.work_enqueue('forecast-inputs',gen_random_uuid()::text,now(),'{"schedulerChunk":"forecasts"}');
    END IF;
    RETURN;
  END IF;
  IF v_item.kind='league-inventory-hint-drain' AND (v_payload->>'delay')::int=0 THEN v_function:=NULL; END IF;
  IF v_item.kind='pre-tipoff' THEN
    v_tipoff:=(v_payload->>'tipoffAt')::timestamptz;
    IF v_tipoff<=now()-interval '1 minute' THEN RAISE EXCEPTION 'Tipoff window has closed'; END IF;
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date) VALUES(v_tipoff,(v_tipoff AT TIME ZONE 'America/New_York')::date) ON CONFLICT DO NOTHING;
    UPDATE public.lineup_tipoff_dispatches SET status='queued',token=p_token,attempts=attempts+1,
      lease_until=v_item.lease_until,error=NULL,input_revision=input_revision+(input_fingerprint IS DISTINCT FROM v_payload->>'fingerprint')::int,
      input_fingerprint=v_payload->>'fingerprint' WHERE tipoff_at=v_tipoff;
    v_payload:=(v_payload-'fingerprint')||jsonb_build_object('token',p_token);
  END IF;
  IF v_function IS NOT NULL THEN
    PERFORM set_config('pancake.work_id',p_id::text,true);
    PERFORM public.invoke_edge_function(v_function,v_payload);
    PERFORM set_config('pancake.work_id',v_previous,true);
    RETURN;
  END IF;
  CASE v_item.kind
    WHEN 'refresh-views' THEN
      FOR v_claim IN SELECT value FROM jsonb_array_elements(public.view_refresh_work(p_params:='{"operation":"claim"}')) LOOP
        PERFORM public.view_refresh_work(p_league_id:=(v_claim->>'leagueId')::uuid,
          p_params:=v_claim||jsonb_build_object('operation','complete'));
      END LOOP;
    WHEN 'refresh-live-matchups' THEN PERFORM private.refresh_live_matchup_totals();
    WHEN 'trade-publication' THEN PERFORM private.publish_trade_changes((v_payload->>'publicationId')::uuid);
    WHEN 'setup-season-rollover' THEN PERFORM private.roll_setup_league_seasons(now());
    WHEN 'daily-stat-corrections' THEN PERFORM public.queue_daily_stat_corrections();
    WHEN 'missing-final-stats' THEN PERFORM private.reconcile_missing_final_stats(now(),(v_payload->>'beforeDate')::date);
    WHEN 'edge-invocation-reconcile' THEN PERFORM private.reconcile_edge_invocations();
    WHEN 'player-stats-hints' THEN PERFORM private.flush_player_stats_hints();
    WHEN 'league-inventory-hint-drain' THEN PERFORM private.flush_league_inventory_hints(1000);
    WHEN 'cleanup-trade-estimates' THEN PERFORM public.cleanup_trade_estimate_quotes();
    WHEN 'mock-room-expiry' THEN PERFORM public.expire_mock_draft_rooms();
    WHEN 'public-read-retention' THEN PERFORM public.public_prune_read_log();
    WHEN 'retention-prune' THEN PERFORM private.run_retention();
    ELSE RAISE EXCEPTION 'Unknown SQL work kind: %',v_item.kind;
  END CASE;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_matchup_forecasts(p_limit integer DEFAULT 10)
RETURNS TABLE(matchup_id uuid, revision bigint, claim_token uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH candidates AS (
    SELECT queued.matchup_id FROM private.matchup_forecast_queue queued
    WHERE queued.dirty AND queued.available_at<=now()
      AND (SELECT due_at FROM private.matchup_forecast_schedule schedule WHERE schedule.matchup_id=queued.matchup_id)<=now()
      AND NOT private.matchup_forecast_refresh_pending(queued.matchup_id)
      AND (queued.claimed_at IS NULL OR queued.claimed_at<now()-interval '3 minutes')
    ORDER BY queued.changed_at,queued.matchup_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit,10),1),25)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.matchup_forecast_queue queued SET claim_token=gen_random_uuid(),claimed_at=now(),claimed_revision=queued.revision,
    claimed_fingerprint=COALESCE(queued.input_fingerprint,private.matchup_forecast_input_fingerprint(queued.matchup_id))
  FROM candidates WHERE queued.matchup_id=candidates.matchup_id
  RETURNING queued.matchup_id,queued.revision,queued.claim_token;
$$;

CREATE OR REPLACE FUNCTION public.complete_matchup_forecast(
  p_matchup_id uuid, p_revision bigint, p_claim_token uuid, p_forecast jsonb, p_valid_until timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.matchup_forecast_queue%ROWTYPE; forecast_league_id uuid;
BEGIN
  SELECT league.id INTO forecast_league_id FROM public.leagues league
  JOIN public.matchups matchup ON matchup.league_id=league.id
  WHERE matchup.id=p_matchup_id FOR KEY SHARE OF league;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.matchups matchup
  WHERE matchup.id=p_matchup_id AND matchup.league_id=forecast_league_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO queued FROM private.matchup_forecast_queue WHERE matchup_id=p_matchup_id FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS DISTINCT FROM p_claim_token OR queued.claimed_revision IS DISTINCT FROM p_revision THEN RETURN false; END IF;
  IF queued.revision<>p_revision OR private.matchup_forecast_refresh_pending(p_matchup_id) THEN
    UPDATE private.matchup_forecast_queue SET claim_token=NULL,claimed_at=NULL,claimed_revision=NULL WHERE matchup_id=p_matchup_id;
    RETURN false;
  END IF;
  IF jsonb_typeof(p_forecast) IS DISTINCT FROM 'object' OR p_forecast->>'modelVersion' IS NULL
    OR jsonb_typeof(p_forecast->'teams') IS DISTINCT FROM 'array' OR jsonb_array_length(p_forecast->'teams')<>2 THEN
    RAISE EXCEPTION 'A complete versioned forecast is required.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,calculated_at,valid_until)
  VALUES(p_matchup_id,forecast_league_id,p_revision,p_forecast,now(),CASE WHEN (SELECT is_finalized FROM public.matchups WHERE id=p_matchup_id) THEN now()+interval '100 years'
    ELSE GREATEST(LEAST(COALESCE(p_valid_until,now()+interval '1 day'),
      (queued.claimed_fingerprint->>'validUntil')::timestamptz),now()+interval '1 second') END)
  ON CONFLICT(matchup_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,forecast=EXCLUDED.forecast,
    calculated_at=EXCLUDED.calculated_at,valid_until=EXCLUDED.valid_until;
  UPDATE private.matchup_forecast_queue SET dirty=false,claim_token=NULL,claimed_at=NULL,claimed_revision=NULL,last_error=NULL,
    computed_fingerprint=queued.claimed_fingerprint,claimed_fingerprint=NULL,
    finalized=(SELECT is_finalized FROM public.matchups WHERE id=p_matchup_id),
    available_at=now()+interval '30 minutes'
  WHERE matchup_id=p_matchup_id;
  IF (SELECT is_finalized FROM public.matchups WHERE id=p_matchup_id) THEN
    DELETE FROM private.forecast_refresh_requests WHERE matchup_id=p_matchup_id;
  END IF;
  RETURN true;
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

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
  IF p_params->>'operation'='begin-trade' THEN
    RETURN to_jsonb(private.begin_trade_revaluation((p_params->>'tradeId')::uuid,p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='check-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      private.trade_revaluation_input_version((p_params->>'tradeId')::uuid),p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='trade-ready' THEN
    RETURN to_jsonb(EXISTS(SELECT 1 FROM public.trades trade WHERE trade.id=(p_params->>'tradeId')::uuid
      AND trade.status IN ('pending','accepted') AND NOT EXISTS(SELECT 1 FROM private.trade_value_publications published
        WHERE published.trade_id=trade.id AND published.input_fingerprint=p_params->>'inputFingerprint'
          AND published.model_version=p_params->>'modelVersion')));
  END IF;
  IF p_params->>'operation'='queue-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      p_params->>'inputFingerprint',p_params->>'modelVersion',p_params->'inputs'));
  END IF;
  IF p_params->>'operation'='queue-trades' THEN
    RETURN private.refresh_queue_trade_revaluations((p_params->>'seasonId')::uuid,
      (p_params->>'version')::bigint,p_params->>'modelVersion',(p_params->>'after')::uuid);
  END IF;
  IF p_params->>'operation'='publish-trade' THEN
    RETURN to_jsonb(private.refresh_trade_values(p_league_id,(p_params->>'seasonId')::uuid,
      (SELECT version FROM private.screen_refresh_queue WHERE league_season_id=(p_params->>'seasonId')::uuid),
      jsonb_build_array(jsonb_build_object('tradeId',p_params->>'tradeId','revaluation',p_params->'revaluation'))));
  END IF;
  IF COALESCE(p_params->>'operation', 'claim') = 'claim' THEN
    WITH candidates AS (
      SELECT league_season_id FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')
      ORDER BY changed_at, league_season_id LIMIT LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 1), 1), 1)
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE private.screen_refresh_queue q SET claimed_at = now(), claim_token = gen_random_uuid(), claimed_version = q.version
      FROM candidates c WHERE q.league_season_id = c.league_season_id RETURNING q.*
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('leagueId', c.league_id, 'seasonId', c.league_season_id,
      'version', c.version, 'claimToken', c.claim_token)), '[]'::jsonb) INTO result FROM claimed c;
    RETURN result;
  END IF;
  SELECT * INTO queued FROM private.screen_refresh_queue WHERE league_id = p_league_id
    AND league_season_id = (p_params->>'seasonId')::uuid FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS NULL OR queued.claim_token IS DISTINCT FROM (p_params->>'claimToken')::uuid
    OR queued.claimed_version IS DISTINCT FROM (p_params->>'version')::bigint THEN RETURN 'false'; END IF;
  IF p_params->>'operation' = 'fail' THEN
    UPDATE private.screen_refresh_queue SET claim_token = NULL, claimed_at = NULL, claimed_version = NULL,
      available_at = now() + interval '1 minute', last_error = left(p_params->>'error', 1000) WHERE league_season_id = queued.league_season_id;
    RETURN 'true';
  END IF;
  IF p_params->>'operation' IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'Unknown refresh operation.' USING ERRCODE = '22023'; END IF;
  completed := queued.version = queued.claimed_version;
  IF completed THEN
    IF queued.standings_dirty THEN
      PERFORM private.refresh_standings(queued.league_id, queued.league_season_id, queued.version);
    END IF;
    PERFORM private.refresh_matchup_totals(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_player_averages(queued.league_id, queued.league_season_id, queued.version);
  END IF;
  UPDATE private.screen_refresh_queue SET dirty = NOT completed, claim_token = NULL, claimed_at = NULL,
    claimed_version = NULL, last_error = NULL,
    standings_dirty=CASE WHEN completed THEN false ELSE standings_dirty END,
    last_refreshed_at=CASE WHEN completed THEN now() ELSE last_refreshed_at END,
    available_at=now()+interval '2 minutes' WHERE league_season_id = queued.league_season_id;
  RETURN to_jsonb(completed);
END;
$$;

DROP TRIGGER zz_live_totals_game ON public.nba_games;
CREATE TRIGGER zz_live_totals_game AFTER UPDATE OF nba_game_id,status,season_year ON public.nba_games
  FOR EACH ROW EXECUTE FUNCTION private.rebuild_game_player_totals();
DROP TRIGGER queue_live_matchup_refresh ON public.matchups;
DO $$
DECLARE league uuid;
BEGIN
  FOR league IN SELECT DISTINCT matchup.league_id FROM private.live_matchup_refresh_queue queued
    JOIN public.matchups matchup ON matchup.id=queued.matchup_id LOOP
    PERFORM private.refresh_queue_screen_views(league);
  END LOOP;
END;
$$;
TRUNCATE private.live_matchup_refresh_queue;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='io-hint-drain';
SELECT cron.alter_job(jobid,schedule:='* * * * *') FROM cron.job WHERE jobname='work-dispatcher';

TRUNCATE analytics.player_season_totals;
INSERT INTO analytics.player_season_totals(player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double)
    SELECT s.player_id,s.season_year,count(*)::bigint AS games_played,
      COALESCE(sum(s.minutes_played),0) AS minutes_played, count(s.minutes_played)::bigint AS minutes_played_count,
      COALESCE(sum(s.points),0) AS points, count(s.points)::bigint AS points_count,
      COALESCE(sum(s.rebounds),0) AS rebounds, count(s.rebounds)::bigint AS rebounds_count,
      COALESCE(sum(s.offensive_rebounds),0) AS offensive_rebounds, count(s.offensive_rebounds)::bigint AS offensive_rebounds_count,
      COALESCE(sum(s.defensive_rebounds),0) AS defensive_rebounds, count(s.defensive_rebounds)::bigint AS defensive_rebounds_count,
      COALESCE(sum(s.assists),0) AS assists, count(s.assists)::bigint AS assists_count,
      COALESCE(sum(s.steals),0) AS steals, count(s.steals)::bigint AS steals_count,
      COALESCE(sum(s.blocks),0) AS blocks, count(s.blocks)::bigint AS blocks_count,
      COALESCE(sum(s.turnovers),0) AS turnovers, count(s.turnovers)::bigint AS turnovers_count,
      COALESCE(sum(s.personal_fouls),0) AS personal_fouls, count(s.personal_fouls)::bigint AS personal_fouls_count,
      COALESCE(sum(s.field_goals_made),0) AS field_goals_made, count(s.field_goals_made)::bigint AS field_goals_made_count,
      COALESCE(sum(s.field_goals_attempted),0) AS field_goals_attempted, count(s.field_goals_attempted)::bigint AS field_goals_attempted_count,
      COALESCE(sum(s.three_pointers_made),0) AS three_pointers_made, count(s.three_pointers_made)::bigint AS three_pointers_made_count,
      COALESCE(sum(s.three_pointers_attempted),0) AS three_pointers_attempted, count(s.three_pointers_attempted)::bigint AS three_pointers_attempted_count,
      COALESCE(sum(s.free_throws_made),0) AS free_throws_made, count(s.free_throws_made)::bigint AS free_throws_made_count,
      COALESCE(sum(s.free_throws_attempted),0) AS free_throws_attempted, count(s.free_throws_attempted)::bigint AS free_throws_attempted_count,
      COALESCE(sum(s.plus_minus),0) AS plus_minus, count(s.plus_minus)::bigint AS plus_minus_count,
      count(*) FILTER(WHERE s.double_double)::bigint AS double_double,
      count(*) FILTER(WHERE s.triple_double)::bigint AS triple_double
    FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
    WHERE g.status='Final' AND NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id)
    GROUP BY s.player_id,s.season_year;

UPDATE private.work_items SET due_at=private.trade_revaluation_next_change()
WHERE kind IN ('sync-players','sync-trade-values','sync-rankings','trade-revaluation-scan','trade-revaluation-check')
  AND status IN ('pending','failed') AND due_at<private.trade_revaluation_next_change();

COMMIT;
