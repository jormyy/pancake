CREATE TABLE private.forecast_refresh_requests(
  scope text PRIMARY KEY,
  league_id uuid REFERENCES public.leagues(id) ON DELETE CASCADE,
  matchup_id uuid REFERENCES public.matchups(id) ON DELETE CASCADE,
  after_matchup_id uuid,
  revision bigint NOT NULL DEFAULT 1,
  available_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forecast_refresh_requests_due ON private.forecast_refresh_requests(available_at,scope);
ALTER TABLE private.forecast_refresh_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.forecast_refresh_requests FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE private.notification_scan_state(
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  available_at timestamptz NOT NULL DEFAULT now(),
  cycle bigint NOT NULL DEFAULT 0,
  scan_at timestamptz,
  after_member_id uuid
);
ALTER TABLE private.notification_scan_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.notification_scan_state FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE private.notification_season_scan_cache(
  season_id uuid PRIMARY KEY REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  cycle bigint NOT NULL,
  first_day date
);
ALTER TABLE private.notification_season_scan_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.notification_season_scan_cache FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.notification_scan_state(id) VALUES(true);
INSERT INTO private.work_kinds(kind,function_name) VALUES('forecast-inputs','refresh-views'),('notification-scan','refresh-views');

CREATE TABLE private.notification_scan_dirty(id boolean PRIMARY KEY DEFAULT true CHECK(id));
ALTER TABLE private.notification_scan_dirty ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.notification_scan_dirty FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.notification_scan_dirty(id) VALUES(true);
CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL,p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  INSERT INTO private.forecast_refresh_requests AS requested(scope,league_id,matchup_id,available_at)
  VALUES(CASE WHEN p_matchup_id IS NOT NULL THEN 'matchup:'||p_matchup_id
    WHEN p_league_id IS NOT NULL THEN 'league:'||p_league_id ELSE 'all' END,p_league_id,p_matchup_id,now())
  ON CONFLICT(scope) DO UPDATE SET revision=requested.revision+1,after_matchup_id=NULL,available_at=LEAST(requested.available_at,EXCLUDED.available_at);
$$;

CREATE OR REPLACE FUNCTION private.refresh_matchup_forecast_input(p_matchup_id uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE due timestamptz;
BEGIN
  SELECT CASE WHEN first_week.week_start>(now() AT TIME ZONE 'America/New_York')::date+14
    THEN (first_week.week_start-14)::timestamp AT TIME ZONE 'America/New_York' ELSE now() END INTO due
  FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE matchup.id=p_matchup_id AND NOT matchup.is_voided
    AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1;
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
    revision=queued.revision+CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN 1 ELSE 0 END,
    changed_at=CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN transaction_timestamp() ELSE queued.changed_at END,
    dirty=queued.computed_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs',
    available_at=CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN now() ELSE queued.available_at END,
    input_fingerprint=EXCLUDED.input_fingerprint
  WHERE queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs'
    OR (queued.input_fingerprint->>'validUntil')::timestamptz<=now();
  UPDATE public.matchup_forecasts cached SET valid_until=GREATEST((queued.input_fingerprint->>'validUntil')::timestamptz,now()+interval '1 second')
  FROM private.matchup_forecast_queue queued WHERE cached.matchup_id=queued.matchup_id
    AND NOT queued.dirty AND cached.valid_until<=now()
    AND (p_matchup_id IS NULL OR cached.matchup_id=p_matchup_id);
  SELECT (input_fingerprint->>'validUntil')::timestamptz INTO due FROM private.matchup_forecast_queue WHERE matchup_id=p_matchup_id;
  RETURN due;
END;
$$;

REVOKE ALL ON FUNCTION private.refresh_matchup_forecast_input(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.complete_forecast_input_chunk()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE requested private.forecast_refresh_requests%ROWTYPE; matchup uuid; due timestamptz; processed integer:=0; input_revision bigint;
BEGIN
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
  RETURN jsonb_build_object('processed',processed,'remaining',EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now()));
END;
$$;

REVOKE ALL ON FUNCTION private.complete_forecast_input_chunk() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.matchup_forecast_refresh_pending(p_matchup_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.matchups matchup JOIN private.forecast_refresh_requests requested
    ON requested.scope IN('all','league:'||matchup.league_id,'matchup:'||matchup.id)
    WHERE matchup.id=p_matchup_id AND requested.available_at<=now());
$$;

REVOKE ALL ON FUNCTION private.matchup_forecast_refresh_pending(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=p_now) THEN
    PERFORM private.work_enqueue('forecast-inputs',date_trunc('minute',p_now)::text,p_now,'{"schedulerChunk":"forecasts"}');
  END IF;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.requeue_deleted_matchup_forecast()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.matchups WHERE id=OLD.matchup_id) THEN
    PERFORM private.queue_matchup_forecasts(NULL,OLD.matchup_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.requeue_deleted_matchup_forecast() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_matchup_forecast(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.matchups matchup
    JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
    JOIN public.league_members member ON member.league_id=league.id AND member.user_id=auth.uid()
    WHERE matchup.id=p_matchup_id
  ) THEN RAISE EXCEPTION 'This matchup is not available.' USING ERRCODE='42501'; END IF;
  SELECT cached.forecast||jsonb_build_object('matchupId',cached.matchup_id,'calculatedAt',cached.calculated_at,
    'inputRevision',cached.input_revision,'validUntil',cached.valid_until,
    'stale',COALESCE(queued.dirty,false) OR cached.valid_until<=now() OR private.matchup_forecast_refresh_pending(p_matchup_id))
  INTO result FROM public.matchup_forecasts cached
  LEFT JOIN private.matchup_forecast_queue queued ON queued.matchup_id=cached.matchup_id
  WHERE cached.matchup_id=p_matchup_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_matchup_forecasts(p_limit integer DEFAULT 10)
RETURNS TABLE(matchup_id uuid, revision bigint, claim_token uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH candidates AS (
    SELECT queued.matchup_id FROM private.matchup_forecast_queue queued
    WHERE queued.dirty AND queued.available_at<=now()
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

CREATE OR REPLACE FUNCTION private.mark_notification_scan_due()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO private.notification_scan_dirty(id) VALUES(true) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.mark_notification_scan_due() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.scan_notification_member(p_member_id uuid,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE member record; candidate record; first_day date; today date:=(p_now AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT m.id,m.league_id,league.status,league.trade_deadline,season.id AS season_id,season.season_year
    INTO member FROM public.league_members m JOIN public.leagues league ON league.id=m.league_id AND league.deleted_at IS NULL
    LEFT JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current WHERE m.id=p_member_id;
  IF NOT FOUND THEN RETURN; END IF;
  FOR candidate IN SELECT pick.id,draft.id AS draft_id FROM public.snake_draft_picks pick
    JOIN public.drafts draft ON draft.id=pick.draft_id
    WHERE pick.member_id=p_member_id AND draft.status='in_progress' AND NOT draft.is_mock
      AND pick.picked_at IS NULL AND pick.skipped_at IS NULL
      AND pick.timer_expires_at>p_now AND pick.timer_expires_at<=p_now+interval '1 minute'
  LOOP
    PERFORM private.notif_enqueue('draft_timer_expiring',candidate.id::text,member.league_id,p_member_id,
      jsonb_build_object('draftId',candidate.draft_id,'pickId',candidate.id));
  END LOOP;
  IF member.season_id IS NULL THEN RETURN; END IF;
  IF member.status IN('active','playoffs') AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.game_date=today
      AND private.lineup_game_available(game.status,game.game_status_text) AND game.game_time<=p_now+interval '2 hours')
    AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.game_date=today
      AND private.lineup_game_available(game.status,game.game_status_text) AND game.status='Scheduled' AND game.game_time>p_now
      AND (game.started_at IS NULL OR game.started_at>p_now)) THEN
    FOR candidate IN SELECT * FROM private.notif_lineup_candidates_scoped(p_now,member.league_id,p_member_id) LOOP
      PERFORM private.notif_enqueue(candidate.event_type,candidate.league_id||':'||candidate.game_date||COALESCE(':'||candidate.player_id,''),
        candidate.league_id,candidate.member_id,jsonb_build_object('memberId',candidate.member_id,'gameDate',candidate.game_date,'playerId',candidate.player_id));
    END LOOP;
  END IF;
  IF member.status='active' THEN
    SELECT cached.first_day INTO first_day FROM private.notification_season_scan_cache cached
      WHERE cached.season_id=member.season_id AND cached.cycle=(SELECT cycle FROM private.notification_scan_state WHERE id);
    IF NOT FOUND THEN
      SELECT CASE WHEN today BETWEEN week.week_start AND week.week_end THEN private.notif_first_scoring_day(member.season_id) END
        INTO first_day FROM public.season_weeks week JOIN public.league_seasons season ON season.id=member.season_id
        WHERE week.season_year=member.season_year AND NOT week.week_number=ANY(season.skipped_weeks)
        ORDER BY week.week_number LIMIT 1;
      INSERT INTO private.notification_season_scan_cache(season_id,cycle,first_day)
        SELECT member.season_id,cycle,first_day FROM private.notification_scan_state WHERE id
      ON CONFLICT(season_id) DO UPDATE SET cycle=EXCLUDED.cycle,first_day=EXCLUDED.first_day;
    END IF;
    IF today=first_day THEN
      PERFORM private.notif_enqueue('season_started',member.season_id::text,member.league_id,p_member_id,
        jsonb_build_object('leagueSeasonId',member.season_id));
    END IF;
    IF private.trade_deadline_for_season(member.trade_deadline,member.season_year)>today
      AND private.trade_deadline_for_season(member.trade_deadline,member.season_year)<=today+3 THEN
      PERFORM private.notif_enqueue('trade_deadline_approaching',member.season_id::text,member.league_id,p_member_id,
        jsonb_build_object('leagueSeasonId',member.season_id));
    END IF;
  END IF;
  FOR candidate IN SELECT matchup.*,ending.week_end FROM public.matchups matchup
    JOIN public.season_weeks first_week ON first_week.season_year=member.season_year AND first_week.week_number=matchup.week_number
    JOIN public.season_weeks ending ON ending.season_year=member.season_year AND ending.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
    JOIN public.league_seasons season ON season.id=member.season_id
    WHERE matchup.league_season_id=member.season_id AND p_member_id IN(matchup.home_member_id,matchup.away_member_id)
      AND NOT matchup.is_finalized AND NOT matchup.is_voided AND today BETWEEN first_week.week_start AND ending.week_end
      AND NOT matchup.week_number=ANY(season.skipped_weeks)
  LOOP
    PERFORM private.notif_enqueue('matchup_started',candidate.id::text,member.league_id,p_member_id,jsonb_build_object('matchupId',candidate.id));
    IF today=candidate.week_end AND candidate.home_points IS NOT NULL AND candidate.away_points IS NOT NULL
      AND abs(candidate.home_points-candidate.away_points)<=greatest(10,(candidate.home_points+candidate.away_points)*0.025) THEN
      PERFORM private.notif_enqueue('matchup_close',candidate.id::text,member.league_id,p_member_id,jsonb_build_object('matchupId',candidate.id));
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.scan_notification_member(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.dispatch_notification_delivery(p_now timestamptz,p_cycle bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item private.work_items%ROWTYPE;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.notification_outbox WHERE suppressed_at IS NULL AND delivered_at IS NULL
    AND dead_lettered_at IS NULL AND available_at<=p_now) THEN RETURN; END IF;
  PERFORM private.work_enqueue('process-trades','notification-scan:'||p_cycle,p_now,
    jsonb_build_object('notificationCycle',p_cycle));
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.work_claim',0)) THEN RETURN; END IF;
  WITH due AS (
    SELECT id FROM private.work_items WHERE kind='process-trades' AND status IN('pending','failed') AND due_at<=p_now
      AND (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<4
    ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE private.work_items stored SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
    FROM due WHERE stored.id=due.id RETURNING stored.* INTO item;
  IF FOUND THEN PERFORM private.work_execute(item.id,item.lease_token); END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.dispatch_notification_delivery(timestamptz,bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.complete_notification_scan_chunk(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state private.notification_scan_state%ROWTYPE; member uuid; next_due timestamptz;
BEGIN
  SELECT * INTO state FROM private.notification_scan_state WHERE id AND (available_at<=p_now OR scan_at IS NOT NULL OR EXISTS(SELECT 1 FROM private.notification_scan_dirty)) FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('processed',0,'remaining',false); END IF;
  IF state.scan_at IS NULL THEN
    UPDATE private.notification_scan_state SET scan_at=p_now,after_member_id=NULL,cycle=cycle+1
      WHERE id RETURNING * INTO state;
    DELETE FROM private.notification_scan_dirty;
    RETURN jsonb_build_object('processed',0,'remaining',true);
  END IF;
  SELECT m.id INTO member FROM public.league_members m JOIN public.leagues league ON league.id=m.league_id AND league.deleted_at IS NULL
    WHERE state.after_member_id IS NULL OR m.id>state.after_member_id ORDER BY m.id LIMIT 1;
  IF member IS NOT NULL THEN
    PERFORM private.scan_notification_member(member,state.scan_at);
    UPDATE private.notification_scan_state SET after_member_id=member WHERE id;
    RETURN jsonb_build_object('processed',1,'remaining',true);
  END IF;
  SELECT LEAST(((p_now AT TIME ZONE 'America/New_York')::date+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(game_time)-interval '2 hours' FROM public.nba_games WHERE game_date=(p_now AT TIME ZONE 'America/New_York')::date
      AND status='Scheduled' AND game_time>p_now+interval '2 hours'),
    (SELECT min(pick.timer_expires_at)-interval '1 minute' FROM public.snake_draft_picks pick
      JOIN public.drafts draft ON draft.id=pick.draft_id AND draft.status='in_progress' AND NOT draft.is_mock
      WHERE pick.picked_at IS NULL AND pick.skipped_at IS NULL AND pick.timer_expires_at>p_now+interval '1 minute'),
    CASE WHEN EXISTS(SELECT 1 FROM public.nba_games WHERE game_date=(p_now AT TIME ZONE 'America/New_York')::date
      AND status='Scheduled' AND game_time>p_now AND game_time<=p_now+interval '2 hours')
      THEN p_now+interval '1 minute' END) INTO next_due;
  UPDATE private.notification_scan_state SET scan_at=NULL,after_member_id=NULL,
    available_at=CASE WHEN EXISTS(SELECT 1 FROM private.notification_scan_dirty) THEN p_now+interval '1 minute' ELSE next_due END WHERE id;
  PERFORM private.enqueue_process_trades(p_now);
  PERFORM private.dispatch_notification_delivery(p_now,state.cycle);
  RETURN jsonb_build_object('processed',0,'remaining',false);
END;
$$;

REVOKE ALL ON FUNCTION private.complete_notification_scan_chunk(timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.notif_scan_due_atomic(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF (NOT EXISTS(SELECT 1 FROM private.notification_scan_state WHERE id AND (available_at<=p_now OR scan_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM private.notification_scan_dirty))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('scheduler-chunk:notification-scan',0)) THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='notification-scan' AND status IN('pending','running','failed')) THEN
    UPDATE private.work_items SET payload=jsonb_build_object('schedulerChunk','notifications','at',p_now),due_at=LEAST(due_at,p_now)
      WHERE kind='notification-scan' AND status IN('pending','failed') AND payload->>'at' IS DISTINCT FROM to_jsonb(p_now)#>>'{}';
    RETURN;
  END IF;
  PERFORM private.work_enqueue('notification-scan',date_trunc('minute',p_now)::text,p_now,
    jsonb_build_object('schedulerChunk','notifications','at',p_now));
END;
$$;

CREATE OR REPLACE FUNCTION public.run_scheduler_chunk(p_kind text,p_requeue boolean DEFAULT false,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE selected_kind text; result jsonb;
BEGIN
  selected_kind:=CASE p_kind WHEN 'forecasts' THEN 'forecast-inputs' WHEN 'notifications' THEN 'notification-scan' END;
  IF selected_kind IS NULL THEN RAISE EXCEPTION 'Unknown scheduler chunk.' USING ERRCODE='22023'; END IF;
  IF p_requeue THEN
    IF pg_try_advisory_xact_lock(hashtextextended('scheduler-chunk:'||selected_kind,0))
      AND NOT EXISTS(SELECT 1 FROM private.work_items WHERE work_items.kind=selected_kind AND status IN('pending','failed')) THEN
      PERFORM private.work_enqueue(selected_kind,gen_random_uuid()::text,now(),
        jsonb_build_object('schedulerChunk',p_kind,'continuation',gen_random_uuid())
          ||CASE WHEN p_kind='notifications' THEN jsonb_build_object('at',p_now) ELSE '{}'::jsonb END);
    END IF;
    RETURN jsonb_build_object('processed',0,'remaining',true);
  END IF;
  IF p_kind='forecasts' THEN result:=private.complete_forecast_input_chunk();
  ELSE result:=private.complete_notification_scan_chunk(p_now); END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.run_scheduler_chunk(text,boolean,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.run_scheduler_chunk(text,boolean,timestamptz) TO service_role;

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
  FOR v_item IN SELECT item.* FROM private.work_items item
    WHERE item.status IN ('pending','failed') AND item.due_at<=now()
      AND NOT EXISTS(SELECT 1 FROM private.work_kinds kind WHERE kind.kind=item.kind AND kind.retired_at IS NOT NULL)
      AND (item.kind<>'trade-revaluation' OR
        (NOT EXISTS(SELECT 1 FROM private.work_items running WHERE running.kind='trade-revaluation'
          AND running.status='running' AND running.lease_until>clock_timestamp() AND running.league_id IS NOT DISTINCT FROM item.league_id)
        AND NOT EXISTS(SELECT 1 FROM private.trade_revaluation_leagues pace WHERE pace.league_id=item.league_id AND pace.next_allowed_at>now())))
    ORDER BY (item.kind IN ('trade-revaluation','trade-revaluation-check','trade-revaluation-scan','forecast-inputs','notification-scan')),item.due_at,item.id
    LIMIT 128 FOR UPDATE SKIP LOCKED
  LOOP
    IF v_item.kind IN('forecast-inputs','notification-scan') AND
      (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())>=3 THEN CONTINUE; END IF;
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
      RETURN NEXT v_item;
      v_count:=v_count+1;
      EXIT WHEN v_count>=v_budget;
    END IF;
  END LOOP;
END;
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
  VALUES(p_matchup_id,forecast_league_id,p_revision,p_forecast,now(),GREATEST(LEAST(COALESCE(p_valid_until,now()+interval '1 day'),
    (queued.claimed_fingerprint->>'validUntil')::timestamptz),now()+interval '1 second'))
  ON CONFLICT(matchup_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,forecast=EXCLUDED.forecast,
    calculated_at=EXCLUDED.calculated_at,valid_until=EXCLUDED.valid_until;
  UPDATE private.matchup_forecast_queue SET dirty=false,claim_token=NULL,claimed_at=NULL,claimed_revision=NULL,last_error=NULL,
    computed_fingerprint=queued.claimed_fingerprint,claimed_fingerprint=NULL
  WHERE matchup_id=p_matchup_id;
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

CREATE TRIGGER requeue_deleted_matchup_forecast AFTER DELETE ON private.matchup_forecast_queue
  FOR EACH ROW EXECUTE FUNCTION private.requeue_deleted_matchup_forecast();
CREATE TRIGGER notification_scan_hint AFTER INSERT OR UPDATE ON public.league_change_hints
  FOR EACH ROW WHEN(NEW.topic IN('lineup','roster','inventory','player','game')) EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_game_insert AFTER INSERT ON public.nba_games
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_game_change AFTER UPDATE OF status,game_status_text,game_time,started_at,game_date ON public.nba_games
  FOR EACH ROW WHEN(ROW(OLD.status,OLD.game_status_text,OLD.game_time,OLD.started_at,OLD.game_date) IS DISTINCT FROM ROW(NEW.status,NEW.game_status_text,NEW.game_time,NEW.started_at,NEW.game_date))
  EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_player_change AFTER UPDATE OF injury_status,status,nba_team,position,eligible_positions ON public.players
  FOR EACH ROW WHEN(ROW(OLD.injury_status,OLD.status,OLD.nba_team,OLD.position,OLD.eligible_positions) IS DISTINCT FROM ROW(NEW.injury_status,NEW.status,NEW.nba_team,NEW.position,NEW.eligible_positions))
  EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_draft_timer AFTER INSERT OR UPDATE OR DELETE ON public.snake_draft_picks
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
SELECT 'matchup:'||matchup.id,matchup.id,CASE WHEN first_week.week_start>(now() AT TIME ZONE 'America/New_York')::date+14
  THEN (first_week.week_start-14)::timestamp AT TIME ZONE 'America/New_York' ELSE now() END
FROM public.matchups matchup
JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
WHERE NOT matchup.is_voided AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1
ON CONFLICT DO NOTHING;


CREATE TRIGGER notification_scan_matchups AFTER INSERT OR UPDATE OR DELETE ON public.matchups
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_lineups AFTER INSERT OR UPDATE OR DELETE ON public.weekly_lineups
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_rosters AFTER INSERT OR UPDATE OR DELETE ON public.roster_players
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_templates AFTER INSERT OR UPDATE OR DELETE ON public.lineup_slot_templates
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_members AFTER INSERT OR UPDATE OR DELETE ON public.league_members
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_seasons AFTER INSERT OR UPDATE OR DELETE ON public.league_seasons
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_leagues AFTER UPDATE OF status,trade_deadline,deleted_at ON public.leagues
  FOR EACH ROW WHEN(ROW(OLD.status,OLD.trade_deadline,OLD.deleted_at) IS DISTINCT FROM ROW(NEW.status,NEW.trade_deadline,NEW.deleted_at))
  EXECUTE FUNCTION private.mark_notification_scan_due();
CREATE TRIGGER notification_scan_memberships AFTER INSERT OR UPDATE OR DELETE ON private.player_game_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION private.mark_notification_scan_due();
