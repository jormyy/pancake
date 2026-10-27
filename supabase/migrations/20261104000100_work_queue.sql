CREATE TABLE private.work_kinds(kind text PRIMARY KEY, function_name text);
CREATE TABLE private.work_items(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL REFERENCES private.work_kinds(kind),
  key text NOT NULL,
  due_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','failed','succeeded','dead')),
  lease_token uuid,
  lease_until timestamptz,
  invocation_key uuid,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object'),
  league_id uuid REFERENCES public.leagues(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(kind,key),
  CHECK((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX work_items_due ON private.work_items(due_at,id) WHERE status IN ('pending','failed');
CREATE INDEX work_items_expired ON private.work_items(lease_until,id) WHERE status='running';
CREATE UNIQUE INDEX work_items_invocation ON private.work_items(invocation_key) WHERE invocation_key IS NOT NULL;
CREATE UNIQUE INDEX work_items_active ON private.work_items(kind,(CASE WHEN kind='pre-tipoff' THEN payload->>'tipoffAt' ELSE md5(payload::text) END)) WHERE status IN ('pending','running','failed');
ALTER TABLE private.work_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.work_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.work_kinds,private.work_items FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.league_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  league_id uuid REFERENCES public.leagues(id) ON DELETE CASCADE,
  member_id uuid REFERENCES public.league_members(id) ON DELETE SET NULL,
  kind text NOT NULL,
  summary text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX league_events_timeline ON public.league_events(league_id,created_at DESC,id DESC);
ALTER TABLE public.league_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.league_events TO authenticated;
GRANT ALL ON public.league_events TO service_role;
CREATE POLICY league_events_member_read ON public.league_events FOR SELECT TO authenticated
USING(EXISTS(SELECT 1 FROM public.league_members member WHERE member.league_id=league_events.league_id AND member.user_id=auth.uid()
  AND (league_events.kind<>'claim.failed' OR member.id=league_events.member_id)));
ALTER TABLE public.edge_invocations ADD COLUMN work_item_id bigint;
ALTER TABLE public.edge_invocations ADD COLUMN work_lease_token uuid;
INSERT INTO private.work_kinds(kind,function_name) VALUES
('close-expired-nominations','close-expired-nominations'),
('stats-sync','sync-stats'),
('process-trades','process-trades'),
('live-poll','live-poll'),
('sync-scores','sync-scores'),
('matchup-forecasts','matchup-forecast'),
('refresh-views','refresh-views'),
('lineup-optimizer','lineup-optimizer'),
('pre-tipoff','lineup-optimizer'),
('sync-players','sync-players'),
('player-injuries','sync-player-injuries'),
('process-waivers','process-waivers'),
('sync-schedule','sync-schedule'),
('season-boundary','season-boundary'),
('sync-rankings','sync-rankings'),
('sync-draft-order','sync-draft-order'),
('pt:sleeper-week','sync-sleeper-projections'),
('pt:sleeper-day','sync-sleeper-projections'),
('pt:fantasypros','sync-projections'),
('setup-season-rollover',NULL),
('daily-stat-corrections',NULL),
('edge-invocation-reconcile',NULL),
('player-stats-hints',NULL),
('league-inventory-hint-drain','dispatcher'),
('pg-net-response-vacuum','dispatcher'),
('cleanup-trade-estimates',NULL),
('mock-room-expiry',NULL),
('retention-prune',NULL);

CREATE OR REPLACE FUNCTION private.work_enqueue(p_kind text, p_key text, p_due_at timestamptz DEFAULT now(), p_payload jsonb DEFAULT '{}'::jsonb, p_league_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
  VALUES(p_kind,p_key,p_due_at,p_payload,p_league_id)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_finish(p_id bigint, p_token uuid, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  UPDATE private.work_items SET
    status=CASE WHEN p_error IS NULL THEN 'succeeded' WHEN attempts>=3 THEN 'dead' ELSE 'failed' END,
    due_at=CASE WHEN p_error IS NULL THEN due_at ELSE now()+make_interval(secs=>least(900,60*power(2,greatest(attempts-1,0))::int)) END,
    completed_at=CASE WHEN p_error IS NULL OR attempts>=3 THEN now() END,
    last_error=left(p_error,4000),lease_until=NULL,lease_token=NULL
  WHERE id=p_id AND status='running' AND lease_token=p_token AND lease_until>now()
  RETURNING * INTO v_item;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_item.status IN ('succeeded','dead') THEN
    INSERT INTO public.league_events(league_id,kind,summary,detail)
    VALUES(v_item.league_id,'work.'||v_item.status,
      v_item.kind||CASE WHEN p_error IS NULL THEN ' completed' ELSE ' failed after three attempts' END,
      jsonb_build_object('work_id',v_item.id,'kind',v_item.kind,'key',v_item.key,'attempts',v_item.attempts,'error',p_error));
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_claim(p_limit integer DEFAULT 64)
RETURNS SETOF private.work_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  FOR v_item IN SELECT * FROM private.work_items WHERE status='running' AND lease_until<=now()
    ORDER BY lease_until,id LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE private.work_items SET lease_until=now()+interval '1 second' WHERE id=v_item.id;
    PERFORM private.work_finish(v_item.id,v_item.lease_token,'Worker lease expired');
  END LOOP;
  RETURN QUERY
    WITH due AS (SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
      ORDER BY due_at,id LIMIT greatest(0,least(p_limit,500)) FOR UPDATE SKIP LOCKED)
    UPDATE private.work_items item SET status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',invocation_key=NULL
    FROM due WHERE item.id=due.id RETURNING item.*;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz;
  v_previous text:=coalesce(current_setting('pancake.work_id',true),'');
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE id=p_id AND lease_token=p_token AND status='running' AND lease_until>now();
  IF NOT FOUND THEN RETURN; END IF;
  SELECT function_name INTO v_function FROM private.work_kinds WHERE kind=v_item.kind;
  v_payload:=v_item.payload;
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
    WHEN 'setup-season-rollover' THEN PERFORM private.roll_setup_league_seasons(now());
    WHEN 'daily-stat-corrections' THEN PERFORM public.queue_daily_stat_corrections();
    WHEN 'edge-invocation-reconcile' THEN PERFORM private.reconcile_edge_invocations();
    WHEN 'player-stats-hints' THEN PERFORM private.flush_player_stats_hints();
    WHEN 'league-inventory-hint-drain' THEN PERFORM private.flush_league_inventory_hints(1000);
    WHEN 'cleanup-trade-estimates' THEN PERFORM public.cleanup_trade_estimate_quotes();
    WHEN 'mock-room-expiry' THEN PERFORM public.expire_mock_draft_rooms();
    WHEN 'retention-prune' THEN
      PERFORM public.prune_unbounded_history();
      DELETE FROM private.work_items WHERE status='succeeded' AND completed_at<now()-interval '7 days';
    ELSE RAISE EXCEPTION 'Unknown SQL work kind: %',v_item.kind;
  END CASE;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;

CREATE OR REPLACE FUNCTION private.work_capture_outcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text; v_member uuid; v_summary text;
BEGIN
  IF TG_TABLE_NAME='waiver_claims' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status::text NOT IN ('succeeded','failed_priority','failed_roster') THEN RETURN NEW; END IF;
    v_kind:=CASE WHEN NEW.status::text='succeeded' THEN 'claim.awarded' ELSE 'claim.failed' END; v_member:=NEW.member_id;
    v_summary:=CASE WHEN NEW.status::text='succeeded' THEN 'Waiver claim awarded' ELSE 'Waiver claim failed' END;
  ELSIF TG_TABLE_NAME='trades' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status::text NOT IN ('completed','vetoed') THEN RETURN NEW; END IF;
    v_kind:=CASE WHEN NEW.status::text='completed' THEN 'trade.executed' ELSE 'trade.vetoed' END;
    v_summary:=CASE WHEN NEW.status::text='completed' THEN 'Trade executed' ELSE 'Trade vetoed' END;
  ELSIF TG_TABLE_NAME='matchups' THEN
    IF NOT NEW.is_finalized OR OLD.is_finalized THEN RETURN NEW; END IF;
    v_kind:='scores.finalized'; v_summary:='Matchup scores finalized';
  END IF;
  INSERT INTO public.league_events(league_id,member_id,kind,summary,detail)
  VALUES(NEW.league_id,v_member,v_kind,v_summary,to_jsonb(NEW));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_daily(p_kind text,p_hour integer,p_minute integer DEFAULT 0,p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_local timestamp:=p_now AT TIME ZONE 'America/New_York';
BEGIN
  IF v_local::time>=make_time(p_hour,p_minute,0) THEN
    PERFORM private.work_enqueue(p_kind,v_local::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_rankings(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_local timestamp:=p_now AT TIME ZONE 'America/New_York'; v_view text;
BEGIN
  IF extract(isodow FROM v_local)=1 AND v_local::time<time '07:00' THEN RETURN; END IF;
  FOREACH v_view IN ARRAY ARRAY['POINT_3','ROOKIE','POINT_5'] LOOP
    PERFORM private.work_enqueue('sync-rankings',to_char(v_local,'IYYY-IW')||':'||v_view,p_now,jsonb_build_object('view',v_view));
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_player_injuries(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_last_tipoff timestamptz;
  v_local time:=(p_now AT TIME ZONE 'America/New_York')::time; v_interval interval;
BEGIN
  SELECT max(game_time) INTO v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND status NOT IN ('Cancelled','Postponed');
  IF v_local>=time '11:00' AND p_now<=v_last_tipoff THEN v_interval:=interval '15 minutes';
  ELSIF v_local>=time '08:00' OR v_local<time '03:00' THEN v_interval:=interval '1 hour';
  ELSE RETURN; END IF;
  PERFORM private.work_enqueue('player-injuries',date_bin(v_interval,p_now,timestamptz '2000-01-01 00:00 UTC')::text,p_now);
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_projection_sync(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_work record;
BEGIN
  FOR v_work IN SELECT * FROM private.projection_sync_due_work(p_now) LOOP
    PERFORM private.work_enqueue(v_work.job_key,v_work.period_key,p_now);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_season_boundary(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (p_now AT TIME ZONE 'America/New_York')::time<time '09:00' THEN RETURN; END IF;
  PERFORM private.work_enqueue('setup-season-rollover',date_trunc('hour',p_now)::text||':'||(extract(minute FROM p_now)::int/15)::text,p_now);
  IF EXISTS(SELECT 1 FROM public.leagues WHERE status IN ('active','playoffs','offseason','drafting')) THEN
    PERFORM private.work_enqueue('season-boundary',(p_now AT TIME ZONE 'America/New_York')::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_pre_tipoff_optimizer(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_window record; v_fingerprint text; v_today date:=(p_now AT TIME ZONE 'America/New_York')::date;
BEGIN
  FOR v_window IN
    SELECT tipoff_at FROM (
    SELECT DISTINCT g.game_time AS tipoff_at
      FROM public.nba_games g
     WHERE g.game_date = v_today
       AND g.status = 'Scheduled'
       AND private.lineup_game_available(g.status, g.game_status_text)
       AND g.game_time > p_now
       AND g.game_time <= p_now + interval '2 minutes'
       AND (g.started_at IS NULL OR g.started_at > p_now)
       AND EXISTS (
         SELECT 1 FROM public.lineup_optimizer_settings s
         JOIN public.league_seasons ls ON ls.id = s.league_season_id
         JOIN public.leagues l ON l.id = s.league_id
         WHERE s.enabled AND ls.is_current AND ls.season_year = g.season_year
           AND l.status IN ('active', 'playoffs')
       )
    UNION
    SELECT d.tipoff_at FROM public.lineup_tipoff_dispatches d
    WHERE d.game_date = v_today AND d.tipoff_at > p_now - interval '1 minute'
      AND d.tipoff_at <= p_now + interval '2 minutes'
    ) windows ORDER BY tipoff_at
  LOOP
    IF v_fingerprint IS NULL THEN v_fingerprint:=private.pre_tipoff_input_fingerprint(v_today); END IF;
    IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
    PERFORM private.work_enqueue('pre-tipoff',v_window.tipoff_at::text||':'||v_fingerprint,p_now,
      jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'fingerprint',v_fingerprint));
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_screen_views(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  ORDER BY season.id ON CONFLICT DO NOTHING;
  UPDATE private.screen_refresh_queue queued SET version = version + 1, dirty = true, available_at = p_now, changed_at = p_now
  WHERE NOT queued.dirty AND EXISTS (
    SELECT 1 FROM public.trade_value_cache cached WHERE cached.league_season_id = queued.league_season_id AND cached.valid_until <= p_now);
  IF EXISTS (SELECT 1 FROM private.screen_refresh_queue WHERE dirty AND available_at <= p_now
    AND (claimed_at IS NULL OR claimed_at < p_now - interval '3 minutes')) THEN
    PERFORM private.work_enqueue('refresh-views',date_trunc('minute',p_now)::text,p_now);
  END IF;
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
  PERFORM private.work_enqueue('player-stats-hints',v_key,p_now);
  PERFORM private.work_enqueue('league-inventory-hint-drain',v_key,p_now,'{"delay":0}');
  PERFORM private.work_enqueue('league-inventory-hint-drain',v_key||':30',p_now,'{"delay":30}');
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
  IF v_min%5=0 THEN PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now); END IF;
  IF v_min=17 THEN PERFORM private.work_enqueue('pg-net-response-vacuum',date_trunc('hour',p_now)::text,p_now,'{"action":"vacuum"}'); END IF;
  IF v_min=0 AND extract(hour FROM v_utc)=13 AND
    ((extract(month FROM v_utc)=6 AND extract(day FROM v_utc)>=20) OR
     (extract(month FROM v_utc)=7 AND extract(day FROM v_utc)<=15)) THEN
    PERFORM private.work_enqueue('sync-draft-order',v_utc::date::text,p_now);
  END IF;
  IF extract(hour FROM v_utc)=8 AND v_min=35 THEN PERFORM private.work_enqueue('cleanup-trade-estimates',v_utc::date::text,p_now); END IF;
  IF extract(hour FROM v_utc)=9 AND v_min=30 THEN PERFORM private.work_enqueue('mock-room-expiry',v_utc::date::text,p_now); END IF;
  IF extract(hour FROM v_utc)=10 AND v_min=0 AND extract(dow FROM v_utc)=0 THEN
    PERFORM private.work_enqueue('retention-prune',v_utc::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_close_expired_nominations(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_horizon timestamptz := p_now + interval '1 minute';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.drafts AS draft
     WHERE draft.status IN ('in_progress'::public.draft_status, 'paused'::public.draft_status)
        OR (draft.draft_type='snake' AND NOT draft.is_mock AND draft.status='completed' AND EXISTS (
          SELECT 1 FROM public.snake_draft_picks AS unmade WHERE unmade.draft_id=draft.id
            AND unmade.player_id IS NULL AND unmade.skipped_at IS NOT NULL))
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.drafts AS draft
    JOIN public.league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    WHERE draft.draft_type = 'snake' AND NOT draft.is_mock
      AND (draft.status IN ('in_progress', 'paused') OR (draft.status='completed' AND EXISTS (
        SELECT 1 FROM public.snake_draft_picks AS unmade WHERE unmade.draft_id=draft.id
          AND unmade.player_id IS NULL AND unmade.skipped_at IS NOT NULL)))
      AND private.draft_timer_opening_night_completion_enabled()
      AND private.draft_timer_opening_night_cutoff(season.season_year) < v_horizon
  ) OR EXISTS (
    SELECT 1
      FROM public.nominations AS nomination
      JOIN public.drafts AS draft
        ON draft.id = nomination.draft_id
     WHERE nomination.status = 'open'::public.nomination_status
       AND nomination.countdown_expires_at < v_horizon
       AND draft.status = 'in_progress'::public.draft_status
  ) OR EXISTS (
    SELECT 1
      FROM public.snake_draft_picks AS pick
      JOIN public.drafts AS draft
        ON draft.id = pick.draft_id
     WHERE pick.player_id IS NULL
       AND pick.skipped_at IS NULL
       AND pick.timer_expires_at IS NOT NULL
       AND pick.timer_expires_at < v_horizon
       AND draft.draft_type = 'snake'
       AND draft.status = 'in_progress'
  ) THEN
    PERFORM private.work_enqueue('close-expired-nominations',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_stats_sync_dispatch(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_horizon timestamptz := p_now + interval '1 minute';
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND (
         job.status = 'pending'
         OR (
           job.status = 'failed'
           AND job.failed_items < 3
           AND COALESCE(job.completed_at, job.created_at) <= v_horizon - make_interval(
             secs => CASE WHEN job.failed_items <= 1 THEN 60 ELSE 300 END
           )
         )
         OR (
           job.status = 'running'
           AND (
             (
               job.claim_token IS NULL
               AND COALESCE(job.claimed_at, job.created_at) <= v_horizon - interval '15 minutes'
             )
             OR (
               job.claim_token IS NOT NULL
               AND (
                 job.claimed_at IS NULL
                 OR job.claimed_at <= v_horizon - interval '120 seconds'
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
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_process_trades(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
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
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_live_poll(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.live_poll_leases WHERE lock_key = 779001 AND expires_at > p_now) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_live_poll_work(p_now)) THEN
    PERFORM private.work_enqueue('live-poll',date_trunc('minute',p_now)::text,p_now);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.edge_invocations
    WHERE function_name = 'sync-scores' AND queued_at > p_now - interval '30 minutes') THEN
    RETURN;
  END IF;
  IF EXISTS (
    WITH candidates AS MATERIALIZED (
      SELECT season.id, matchup.week_number, week.week_end, bool_and(matchup.is_finalized) AS is_finalized
      FROM public.league_seasons season
      JOIN public.leagues league ON league.id = season.league_id
      JOIN public.matchups matchup ON matchup.league_season_id = season.id
      JOIN public.season_weeks week ON week.season_year = season.season_year
        AND week.week_number = COALESCE(matchup.end_week_number, matchup.week_number)
      WHERE season.is_current AND league.status IN ('active', 'playoffs') AND NOT matchup.is_voided
        AND (matchup.matchup_type = 'regular_season' OR NOT private.playoff_matchup_is_consumed(matchup.id))
        AND NOT EXISTS (SELECT 1 FROM public.matchups final
          WHERE final.league_season_id = season.id AND final.matchup_type = 'playoff_final'
            AND final.is_finalized AND NOT final.is_voided)
        AND NOT (matchup.week_number = ANY(season.skipped_weeks))
        AND NOT EXISTS (SELECT 1 FROM private.retired_score_inputs retired WHERE retired.league_season_id = season.id)
        AND week.week_end <= (p_now AT TIME ZONE 'America/New_York')::date
      GROUP BY season.id, matchup.week_number, week.week_end
    ), season_tokens AS MATERIALIZED (
      SELECT candidate.id,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM public.matchups stored WHERE stored.league_season_id = candidate.id
            AND stored.matchup_type <> 'regular_season'
        ) THEN private.score_input_token(candidate.id, max(candidate.week_number)) END AS input_token
      FROM candidates candidate GROUP BY candidate.id
    )
    SELECT 1 FROM candidates candidate
    JOIN season_tokens season_token ON season_token.id = candidate.id
    LEFT JOIN private.score_week_certificates certificate
      ON certificate.league_season_id = candidate.id AND certificate.week_number = candidate.week_number
    WHERE NOT candidate.is_finalized
      OR candidate.week_end >= (p_now AT TIME ZONE 'America/New_York')::date - 4
      OR certificate.input_token IS NULL
      OR certificate.input_token IS DISTINCT FROM CASE WHEN season_token.input_token IS NULL
        THEN private.score_input_token(candidate.id, candidate.week_number)
        ELSE (SELECT jsonb_object_agg(input.key, input.value) FROM jsonb_each(season_token.input_token) input
          WHERE CASE WHEN split_part(input.key, ':', 1) IN ('nba', 'lineup', 'result')
            THEN split_part(input.key, ':', 3)::int <= candidate.week_number ELSE true END)
      END
  ) THEN
    PERFORM private.work_enqueue('sync-scores',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.matchup_forecast_queue(matchup_id)
  SELECT matchup.id FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided AND last_week.week_end>=(p_now AT TIME ZONE 'America/New_York')::date-1
    AND first_week.week_start<=(p_now AT TIME ZONE 'America/New_York')::date+14
    AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue queued WHERE queued.matchup_id=matchup.id)
  ORDER BY matchup.id ON CONFLICT DO NOTHING;
  UPDATE private.matchup_forecast_queue queued SET dirty=true,revision=queued.revision+1,changed_at=p_now,available_at=p_now
  FROM public.matchup_forecasts cached JOIN public.matchups matchup ON matchup.id=cached.matchup_id
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE queued.matchup_id=cached.matchup_id AND NOT queued.dirty AND cached.valid_until<=p_now
    AND last_week.week_end>=(p_now AT TIME ZONE 'America/New_York')::date-1 AND NOT matchup.is_voided;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_lineup_optimizer(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', p_now))::date;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.nba_games
     WHERE game_date BETWEEN v_today AND v_today + 7
  ) THEN
    PERFORM private.work_enqueue('lineup-optimizer',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_work_lease(p_invocation_key uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.work_items SET lease_until=now()+interval '90 seconds'
  WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>now();
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.run_work_maintenance(p_invocation_key uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE invocation_key=p_invocation_key
    AND kind='league-inventory-hint-drain' AND status='running' AND lease_until>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  RETURN private.flush_league_inventory_hints(1000);
END;
$$;

CREATE OR REPLACE FUNCTION public.work_dashboard()
RETURNS TABLE(kind text,due bigint,running bigint,failed bigint,dead bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT kinds.kind,
    count(*) FILTER(WHERE item.status IN ('pending','failed') AND item.due_at<=now()),
    count(*) FILTER(WHERE item.status='running' AND item.lease_until>now()),
    count(*) FILTER(WHERE item.status='failed' OR (item.status='running' AND item.lease_until<=now())),
    count(*) FILTER(WHERE item.status='dead')
  FROM private.work_kinds kinds LEFT JOIN private.work_items item ON item.kind=kinds.kind GROUP BY kinds.kind ORDER BY kinds.kind;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0; v_claimed integer;
BEGIN
  PERFORM private.enqueue_scheduled_work(now());
  LOOP
  v_claimed:=0;
  FOR v_item IN SELECT * FROM private.work_claim(64-v_count) LOOP
    BEGIN
      PERFORM private.work_execute(v_item.id,v_item.lease_token);
    EXCEPTION WHEN OTHERS THEN
      PERFORM private.work_finish(v_item.id,v_item.lease_token,SQLERRM);
    END;
    v_count:=v_count+1; v_claimed:=v_claimed+1;
  END LOOP;
  EXIT WHEN v_claimed=0 OR v_count>=64;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _base_url text;
  _internal_token text;
  _request_id bigint;
  _invocation_key uuid := gen_random_uuid();
BEGIN
  _base_url := NULLIF(rtrim(current_setting('app.supabase_url', true), '/'), '');
  _internal_token := NULLIF(current_setting('app.edge_internal_token', true), '');

  -- Managed Supabase denies ALTER DATABASE/ROLE SET for app.* GUCs, so the
  -- base URL falls back to Vault exactly like the internal token does. The
  -- missing GUC silently killed every cron->edge invocation from 2026-06-28
  -- to 2026-08-15.
  IF _base_url IS NULL THEN
    SELECT NULLIF(rtrim(decrypted_secret, '/'), '')
      INTO _base_url
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_supabase_url'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _internal_token IS NULL THEN
    SELECT NULLIF(decrypted_secret, '')
      INTO _internal_token
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_edge_internal_token'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _base_url IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge base URL is not configured.';
  END IF;

  IF _internal_token IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge internal token is not configured.';
  END IF;

  SELECT net.http_post(
    _base_url || '/functions/v1/' || function_name,
    body,
    NULL,
    jsonb_build_object(
      'x-internal-function-token', _internal_token,
      'Content-Type', 'application/json',
      'x-pancake-invocation-id', _invocation_key::text,
      'x-pancake-work-id', NULLIF(current_setting('pancake.work_id',true),'')
    ),
    30000
  ) INTO _request_id;

  UPDATE private.work_items SET invocation_key=_invocation_key
  WHERE id=NULLIF(current_setting('pancake.work_id',true),'')::bigint AND status='running';

  INSERT INTO public.edge_invocations (
    function_name, request_id, invocation_key, work_item_id, work_lease_token
  ) VALUES (
    function_name, _request_id, _invocation_key,
    NULLIF(current_setting('pancake.work_id',true),'')::bigint,
    (SELECT lease_token FROM private.work_items WHERE id=NULLIF(current_setting('pancake.work_id',true),'')::bigint)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.start_edge_invocation(
  p_invocation_key uuid,
  p_function_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.edge_invocations%ROWTYPE;
  v_run uuid;
BEGIN
  SELECT * INTO v_inv FROM public.edge_invocations
   WHERE invocation_key = p_invocation_key AND function_name = p_function_name
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown invocation for this function'; END IF;
  IF v_inv.worker_started_at IS NOT NULL OR v_inv.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invocation already started or settled';
  END IF;
  IF v_inv.queued_at < clock_timestamp() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Invocation expired before worker startup';
  END IF;
  IF v_inv.work_item_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM private.work_items WHERE id=v_inv.work_item_id AND lease_token=v_inv.work_lease_token AND invocation_key=p_invocation_key AND status='running' AND lease_until>now()
  ) THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.sync_runs (function_name, started_at)
  VALUES (p_function_name, clock_timestamp()) RETURNING id INTO v_run;
  UPDATE public.edge_invocations
     SET worker_started_at = clock_timestamp(), worker_status = 'running', sync_run_id = v_run
   WHERE id = v_inv.id;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_edge_invocation(
  p_invocation_key uuid,
  p_status text,
  p_rows_affected integer DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.edge_invocations%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'Invalid worker outcome';
  END IF;
  SELECT * INTO v_inv FROM public.edge_invocations WHERE invocation_key = p_invocation_key FOR UPDATE;
  IF NOT FOUND OR v_inv.worker_started_at IS NULL THEN RAISE EXCEPTION 'Invocation has no worker'; END IF;
  IF v_inv.worker_finished_at IS NOT NULL THEN RETURN; END IF;
  IF v_inv.work_item_id IS NOT NULL AND NOT private.work_finish(v_inv.work_item_id,v_inv.work_lease_token,CASE WHEN p_status='failed' THEN coalesce(p_error,'Worker failed') END) THEN
    RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409';
  END IF;
  UPDATE public.sync_runs
     SET status = p_status, rows_affected = p_rows_affected, error = left(p_error, 4000),
         finished_at = clock_timestamp()
   WHERE id = v_inv.sync_run_id;
  UPDATE public.edge_invocations
     SET worker_status = p_status, worker_finished_at = clock_timestamp(), reconciled_at = NULL
   WHERE id = v_inv.id;
END;
$$;



CREATE OR REPLACE FUNCTION public.queue_daily_stat_corrections(p_now timestamptz DEFAULT now())
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_local timestamp := p_now AT TIME ZONE 'America/New_York';
  v_start date := v_local::date - 7;
  v_end date := v_local::date - 1;
  v_job_type text := format('sync_stats_range:%s:%s', v_start, v_end);
  v_job_id uuid;
BEGIN
  IF p_now IS NULL OR v_local::time < time '06:20' THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pancake:daily-stat-corrections', 0));

  SELECT id INTO v_job_id
  FROM public.sync_jobs
  WHERE job_type = v_job_type
  ORDER BY created_at DESC, id
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    RETURN v_job_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nba_games
    WHERE game_date BETWEEN v_start AND v_end
      AND nba_game_id LIKE '002%'
      AND status = 'Final'
  ) THEN
    RETURN NULL;
  END IF;

  v_job_id := public.create_or_resume_stats_sync_job_atomic(v_start, v_end);
  PERFORM private.enqueue_stats_sync_dispatch(p_now);
  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.auto_set_lineup_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_game_date, p_assignments), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM 1 FROM public.league_members
  WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_assignments) > 64 THEN
    RAISE EXCEPTION 'Too many lineup assignments.'
      USING ERRCODE = '22023';
  END IF;

  IF p_game_date < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.auto_set_lineup_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
  INSERT INTO public.league_events(league_id,member_id,kind,summary,detail)
  VALUES(p_league_id,p_member_id,'lineup.auto_set','Lineup auto-set',
    jsonb_build_object('league_season_id',p_league_season_id,'game_date',p_game_date,'assignments',p_assignments));
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

-- Canonical SQL source for private.reconcile_edge_invocations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.reconcile_edge_invocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reconciled integer := 0;
  v_row record;
  v_error text;
  v_run uuid;
BEGIN
  FOR v_row IN
    WITH batch AS MATERIALIZED (
      SELECT inv.*
        FROM public.edge_invocations AS inv
       WHERE inv.reconciled_at IS NULL AND inv.queued_at < now() - interval '1 minute'
       ORDER BY inv.queued_at LIMIT 500 FOR UPDATE OF inv SKIP LOCKED
    )
    SELECT batch.*, resp.status_code AS response_status, resp.error_msg, resp.timed_out,
           left(resp.content, 500) AS content
      FROM batch
      LEFT JOIN net._http_response AS resp
        ON resp.id = batch.request_id
       AND resp.created >= (SELECT min(queued_at) FROM batch) - interval '1 minute'
     ORDER BY batch.queued_at
  LOOP
    v_error := CASE
      WHEN v_row.error_msg IS NOT NULL THEN v_row.error_msg
      WHEN v_row.timed_out IS TRUE THEN 'timed out'
      WHEN v_row.response_status NOT BETWEEN 200 AND 299
        THEN 'HTTP ' || v_row.response_status || ': ' || COALESCE(v_row.content, '')
      ELSE NULL END;
    UPDATE public.edge_invocations
       SET status_code = v_row.response_status, error_message = v_error
     WHERE id = v_row.id
       AND (status_code, error_message) IS DISTINCT FROM (v_row.response_status, v_error);

    IF v_row.worker_started_at IS NOT NULL THEN
      IF v_row.worker_finished_at IS NULL THEN
        IF v_row.worker_started_at >= now() - interval '10 minutes' THEN CONTINUE; END IF;
        UPDATE public.sync_runs SET status = 'failed', finished_at = now(),
          error = 'worker did not finish within 10 minutes' WHERE id = v_row.sync_run_id;
        UPDATE public.edge_invocations SET worker_status = 'failed' WHERE id = v_row.id;
      END IF;
    ELSIF v_row.function_name='sync-player-injuries' AND v_row.response_status=404 THEN
      NULL;
    ELSIF v_row.response_status BETWEEN 200 AND 299 AND v_error IS NULL THEN
      NULL;
    ELSE
      IF v_row.invocation_key IS NOT NULL AND v_row.queued_at >= now() - interval '10 minutes' THEN
        CONTINUE;
      END IF;
      IF v_error IS NULL THEN
        IF v_row.invocation_key IS NULL AND v_row.queued_at >= now() - interval '2 hours' THEN CONTINUE; END IF;
        v_error := CASE WHEN v_row.invocation_key IS NULL THEN
          'no response recorded within 2 hours (request never sent or pg_net purged it)'
          ELSE 'no worker or response recorded within 10 minutes' END;
      END IF;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed', v_error)
      RETURNING id INTO v_run;
      UPDATE public.edge_invocations SET sync_run_id = v_run, error_message = v_error WHERE id = v_row.id;
    END IF;
    UPDATE public.edge_invocations SET reconciled_at = now() WHERE id = v_row.id;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  RETURN v_reconciled;
END;
$$;

CREATE TRIGGER league_events_claim AFTER UPDATE OF status ON public.waiver_claims FOR EACH ROW EXECUTE FUNCTION private.work_capture_outcome();
CREATE TRIGGER league_events_trade AFTER UPDATE OF status ON public.trades FOR EACH ROW EXECUTE FUNCTION private.work_capture_outcome();
CREATE TRIGGER league_events_scores AFTER UPDATE OF is_finalized ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.work_capture_outcome();
CREATE OR REPLACE FUNCTION private.work_enforce_lease()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_invocation text:=nullif(nullif(current_setting('request.headers',true),'')::jsonb->>'x-pancake-work-key','');
BEGIN
  IF v_invocation IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM private.work_items WHERE invocation_key=v_invocation::uuid AND status='running' AND lease_until>now() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  RETURN NULL;
END;
$$;
DO $fences$
DECLARE v_table record;
BEGIN
  FOR v_table IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND c.relname NOT IN ('work_items','work_kinds','sync_runs','edge_invocations')
  LOOP
    EXECUTE format('CREATE TRIGGER work_lease_fence BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION private.work_enforce_lease()',v_table.nspname,v_table.relname);
  END LOOP;
END;
$fences$;
DO $acl$
DECLARE v_function record;
BEGIN
  FOR v_function IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='private' AND (p.proname LIKE 'work_%' OR p.proname LIKE 'enqueue_%' AND p.proname NOT IN ('enqueue_trade_status_notification','enqueue_trade_participant_notification'))
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function.signature); END LOOP;
END;
$acl$;
REVOKE ALL ON FUNCTION public.dispatch_work(),public.work_dashboard(),public.renew_work_lease(uuid),public.run_work_maintenance(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_work(),public.work_dashboard(),public.renew_work_lease(uuid),public.run_work_maintenance(uuid) TO service_role;
DROP FUNCTION public.invoke_close_expired_nominations_if_due();
DROP FUNCTION public.invoke_stats_sync_dispatch_if_due();
DROP FUNCTION public.invoke_process_trades_if_due();
DROP FUNCTION public.invoke_live_poll_if_due();
DROP FUNCTION public.invoke_matchup_forecasts_if_due();
DROP FUNCTION public.invoke_lineup_optimizer_if_due();
DROP FUNCTION public.invoke_season_boundary_if_due(timestamptz);
DROP FUNCTION public.invoke_pre_tipoff_optimizer_if_due();
DROP FUNCTION public.invoke_player_injuries_if_due(timestamptz);
DROP FUNCTION public.invoke_projection_sync_if_due();
DROP FUNCTION private.claim_cron_dispatch(text,text);
DROP FUNCTION private.invoke_claimed_edge_function(text,text,jsonb);
DROP FUNCTION public.invoke_edge_function_at_et_time(text,integer,integer,timestamptz);
DROP FUNCTION public.invoke_dynasty_ranking_views_at_et_time(integer,integer,timestamptz);
DROP TABLE public.cron_dispatch_state;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('cleanup-trade-estimates','daily-stat-corrections','edge-invocation-reconcile','league-inventory-hint-drain','matchup-forecasts','mock-room-expiry','nba-close-expired-nominations','nba-dispatch-stats-sync-jobs','nba-lineup-optimizer','nba-live-poll','nba-process-waivers','nba-sync-draft-order-july','nba-sync-draft-order-june','nba-sync-players','nba-sync-projections','nba-sync-rankings','nba-sync-schedule','notification-dispatch-minute','pg-net-response-vacuum','player-stats-hints','retention-prune','season-boundary','refresh-views');
SELECT cron.schedule('work-dispatcher','* * * * *','SELECT public.dispatch_work()');
