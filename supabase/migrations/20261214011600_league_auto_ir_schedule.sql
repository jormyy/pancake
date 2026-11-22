BEGIN;

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
  IF v_due IS NOT NULL AND p_now < v_due THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM public.nba_games g
    WHERE g.game_date = v_today AND g.status = 'Scheduled'
      AND private.lineup_game_available(g.status, g.game_status_text)
      AND (g.game_time IS NULL OR g.game_time > p_now)
      AND (g.started_at IS NULL OR g.started_at > p_now)
      AND (
        EXISTS (
          SELECT 1 FROM public.lineup_optimizer_settings s
          JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
          JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
          WHERE s.enabled AND ls.season_year = g.season_year
            AND s.last_daily_optimized_date IS DISTINCT FROM v_today
        )
        OR EXISTS (
          SELECT 1 FROM private.league_roster_policies policy
          JOIN public.leagues l ON l.id = policy.league_id AND l.status IN ('active', 'playoffs')
          JOIN public.league_seasons ls ON ls.league_id = l.id AND ls.is_current
          WHERE policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
            AND ls.season_year = g.season_year
        )
      )
  ) THEN
    PERFORM private.work_enqueue('lineup-optimizer', v_today::text, p_now,
      jsonb_build_object('mode', 'daily', 'date', v_today));
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.nba_games g
    WHERE g.game_date = v_today AND g.status = 'Scheduled'
      AND private.lineup_game_available(g.status, g.game_status_text)
  ) AND p_now >= v_midnight + interval '6 hours' AND EXISTS (
    SELECT 1 FROM private.league_roster_policies policy
    JOIN public.leagues l ON l.id = policy.league_id AND l.status IN ('active', 'playoffs')
    JOIN public.league_seasons ls ON ls.league_id = l.id AND ls.is_current
    WHERE policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
  ) THEN
    PERFORM private.work_enqueue('lineup-optimizer', v_today::text, p_now,
      jsonb_build_object('mode', 'daily', 'date', v_today));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_pre_tipoff_optimizer(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_window record; v_fingerprint text; v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_attempt int;
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
       AND (
         EXISTS (
           SELECT 1 FROM public.lineup_optimizer_settings s
           JOIN public.league_seasons ls ON ls.id = s.league_season_id
           JOIN public.leagues l ON l.id = s.league_id
           WHERE s.enabled AND ls.is_current AND ls.season_year = g.season_year
             AND l.status IN ('active', 'playoffs')
         )
         OR EXISTS (
           SELECT 1 FROM private.league_roster_policies policy
           JOIN public.leagues l ON l.id = policy.league_id
           JOIN public.league_seasons ls ON ls.league_id = l.id
           WHERE policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
             AND ls.is_current AND ls.season_year = g.season_year
             AND l.status IN ('active', 'playoffs')
         )
       )
    UNION
    SELECT d.tipoff_at FROM public.lineup_tipoff_dispatches d
    WHERE d.game_date = v_today AND d.tipoff_at > p_now - interval '1 minute'
      AND d.tipoff_at <= p_now + interval '2 minutes'
    ) windows ORDER BY tipoff_at
  LOOP
    IF v_fingerprint IS NULL THEN v_fingerprint:=private.pre_tipoff_input_fingerprint(v_today); END IF;
    IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
    SELECT count(*) INTO v_attempt FROM private.work_items item
     WHERE item.kind='pre-tipoff' AND (item.payload->>'tipoffAt')::timestamptz=v_window.tipoff_at;
    PERFORM private.work_enqueue('pre-tipoff',v_window.tipoff_at::text||':'||v_fingerprint||':'||v_attempt::text,p_now,
      jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'fingerprint',v_fingerprint));
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.get_pending_tipoff_members(timestamptz, uuid, uuid[], int);



CREATE OR REPLACE FUNCTION public.get_pending_tipoff_members(
  p_tipoff_at timestamptz,p_token uuid,p_excluded_members uuid[] DEFAULT ARRAY[]::uuid[],p_limit int DEFAULT 100
)
RETURNS TABLE(league_id uuid,league_season_id uuid,member_id uuid,auto_ir boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit<1 THEN RAISE EXCEPTION 'Tipoff batch size must be positive' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
    WHERE tipoff_at=p_tipoff_at AND token=p_token AND status='running'
      AND lease_until>clock_timestamp() AND tipoff_at>clock_timestamp()-interval '1 minute'
      AND game_date=(clock_timestamp() AT TIME ZONE 'America/New_York')::date FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
  RETURN QUERY SELECT setting.league_id,setting.league_season_id,setting.member_id,
    private.league_auto_ir_all_members(setting.league_id)
  FROM public.lineup_optimizer_settings setting
  JOIN public.league_seasons season ON season.id=setting.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=setting.league_id AND league.status IN ('active','playoffs')
  WHERE setting.enabled AND NOT (setting.member_id=ANY(COALESCE(p_excluded_members,ARRAY[]::uuid[])))
    AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date=v_dispatch.game_date AND game.game_time=p_tipoff_at)
    AND NOT EXISTS(SELECT 1 FROM public.lineup_tipoff_members done WHERE done.tipoff_at=p_tipoff_at
      AND done.league_id=setting.league_id AND done.league_season_id=setting.league_season_id
      AND done.member_id=setting.member_id AND done.input_revision=v_dispatch.input_revision)
  ORDER BY setting.last_optimized_at NULLS FIRST,setting.league_id,setting.league_season_id,setting.member_id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pending_auto_ir_members(
  p_game_date date,
  p_tipoff_at timestamptz DEFAULT NULL,
  p_token uuid DEFAULT NULL,
  p_excluded_members uuid[] DEFAULT ARRAY[]::uuid[],
  p_limit int DEFAULT 100,
  p_include_enabled boolean DEFAULT false
)
RETURNS TABLE(league_id uuid, league_season_id uuid, member_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'Auto IR batch size must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_game_date IS DISTINCT FROM (now() AT TIME ZONE 'America/New_York')::date THEN RETURN; END IF;
  IF p_tipoff_at IS NOT NULL THEN
    SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
      WHERE tipoff_at = p_tipoff_at AND token = p_token AND status = 'running'
        AND lease_until > clock_timestamp() AND tipoff_at > clock_timestamp() - interval '1 minute'
        AND game_date = p_game_date FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE = '40001'; END IF;
  END IF;
  RETURN QUERY
  SELECT member.league_id, season.id, member.id
  FROM public.league_members member
  JOIN public.leagues league ON league.id = member.league_id AND league.status IN ('active', 'playoffs')
  JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
  JOIN private.league_roster_policies policy ON policy.league_id = league.id
    AND policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
  LEFT JOIN public.lineup_optimizer_settings setting
    ON setting.league_id = member.league_id AND setting.league_season_id = season.id
   AND setting.member_id = member.id
  WHERE (p_include_enabled OR NOT COALESCE(setting.enabled, false))
    AND NOT (member.id = ANY(COALESCE(p_excluded_members, ARRAY[]::uuid[])))
    AND (p_tipoff_at IS NULL OR EXISTS (
      SELECT 1 FROM public.nba_games game
      WHERE game.season_year = season.season_year AND game.game_date = p_game_date
        AND game.status = 'Scheduled'
        AND private.lineup_game_available(game.status, game.game_status_text)
        AND game.game_time = p_tipoff_at
    ))
    AND (p_tipoff_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.lineup_tipoff_members done
      WHERE done.tipoff_at = p_tipoff_at AND done.league_id = member.league_id
        AND done.league_season_id = season.id AND done.member_id = member.id
        AND done.input_revision = v_dispatch.input_revision
    ))
  ORDER BY member.id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_tipoff_ir_member_done(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token IS DISTINCT FROM p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;
  IF p_tipoff_at <= now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Tipoff window has closed.' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.league_members member
    JOIN public.leagues league ON league.id = member.league_id AND league.status IN ('active', 'playoffs')
    JOIN public.league_seasons season ON season.id = p_league_season_id
      AND season.league_id = league.id AND season.is_current
    WHERE member.id = p_member_id AND member.league_id = p_league_id
      AND private.league_auto_ir_all_members(p_league_id)
  ) THEN
    RAISE EXCEPTION 'Auto IR member not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.lineup_tipoff_members(tipoff_at, league_id, league_season_id, member_id, input_revision)
  VALUES(p_tipoff_at, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision)
  ON CONFLICT (tipoff_at, league_id, league_season_id, member_id, input_revision) DO NOTHING;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_pre_tipoff_lineup_failure(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_error IS NULL OR btrim(p_error) = '' THEN
    RAISE EXCEPTION 'A member failure requires an error.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token IS DISTINCT FROM p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lineup_optimizer_settings
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id)
     AND NOT (private.league_auto_ir_all_members(p_league_id) AND EXISTS (
       SELECT 1 FROM public.league_members member
       WHERE member.id = p_member_id AND member.league_id = p_league_id)) THEN
    RAISE EXCEPTION 'Optimizer setting not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.lineup_tipoff_members(tipoff_at, league_id, league_season_id, member_id, input_revision, error)
  VALUES(p_tipoff_at, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision, left(p_error, 4000))
  ON CONFLICT (tipoff_at, league_id, league_season_id, member_id, input_revision) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pending_tipoff_members(timestamptz, uuid, uuid[], int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_pending_auto_ir_members(date, timestamptz, uuid, uuid[], int, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_tipoff_ir_member_done(timestamptz, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_pre_tipoff_lineup_failure(timestamptz, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_tipoff_members(timestamptz, uuid, uuid[], int) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_auto_ir_members(date, timestamptz, uuid, uuid[], int, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_tipoff_ir_member_done(timestamptz, uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_pre_tipoff_lineup_failure(timestamptz, uuid, uuid, uuid, uuid, text) TO service_role;

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
      lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+CASE WHEN item.kind='pre-tipoff'
        AND private.pre_tipoff_policy_window((item.payload->>'tipoffAt')::timestamptz)
        THEN interval '45 seconds' ELSE interval '5 minutes' END,
      invocation_key=NULL
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

CREATE OR REPLACE FUNCTION private.work_finish(p_id bigint, p_token uuid, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  UPDATE private.work_items SET
    status=CASE WHEN p_error IS NULL THEN 'succeeded' WHEN attempts>=3 THEN 'dead' ELSE 'failed' END,
    due_at=CASE WHEN p_error IS NULL THEN due_at
      WHEN kind='pre-tipoff' AND private.pre_tipoff_policy_window((payload->>'tipoffAt')::timestamptz) THEN now()
      ELSE now()+make_interval(secs=>least(900,60*power(2,greatest(attempts-1,0))::int)) END,
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

CREATE OR REPLACE FUNCTION public.start_work_invocation(
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
  IF v_inv.work_item_id IS NULL THEN
    RAISE EXCEPTION 'Invocation has no work lease' USING ERRCODE='PT409';
  END IF;
  WITH unlocked AS (
    SELECT id FROM private.work_items WHERE id=v_inv.work_item_id AND lease_token=v_inv.work_lease_token
      AND invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp()
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.work_items item SET lease_until=clock_timestamp()+
      CASE WHEN item.kind='pre-tipoff'
        AND private.pre_tipoff_policy_window((item.payload->>'tipoffAt')::timestamptz)
        THEN interval '45 seconds' ELSE interval '5 minutes' END
    FROM unlocked WHERE item.id=unlocked.id;
  IF NOT FOUND AND NOT EXISTS(
    SELECT 1 FROM private.work_items WHERE id=v_inv.work_item_id AND lease_token=v_inv.work_lease_token
      AND invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp()
  ) THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.sync_runs (function_name, started_at)
  VALUES (p_function_name, clock_timestamp()) RETURNING id INTO v_run;
  UPDATE public.edge_invocations
     SET worker_started_at = clock_timestamp(), worker_status = 'running', sync_run_id = v_run
   WHERE id = v_inv.id;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_work_lease(p_invocation_key uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  WITH unlocked AS (
    SELECT id FROM private.work_items WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp()
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.work_items item SET lease_until=clock_timestamp()+
      CASE WHEN item.kind='pre-tipoff'
        AND private.pre_tipoff_policy_window((item.payload->>'tipoffAt')::timestamptz)
        THEN interval '45 seconds' ELSE interval '5 minutes' END
  FROM unlocked WHERE item.id=unlocked.id;
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM private.work_items WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp());
END;
$$;

COMMIT;

CREATE OR REPLACE FUNCTION private.pre_tipoff_policy_window(p_tipoff_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_tipoff_at IS NOT NULL AND EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
      JOIN public.leagues league
        ON league.id = policy.league_id
       AND league.status IN ('active', 'playoffs')
      JOIN public.league_seasons season
        ON season.league_id = league.id
       AND season.is_current
      JOIN public.nba_games game
        ON game.season_year = season.season_year
       AND game.game_time = p_tipoff_at
       AND game.status = 'Scheduled'
       AND private.lineup_game_available(game.status, game.game_status_text)
     WHERE policy.auto_ir_all_members
       AND policy.ir_activated_at IS NOT NULL
  )
$$;

ALTER TABLE public.lineup_tipoff_dispatches ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';
ALTER TABLE public.lineup_tipoff_members ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';
ALTER TABLE public.lineup_tipoff_members DROP CONSTRAINT IF EXISTS lineup_tipoff_members_tipoff_at_fkey;
ALTER TABLE public.lineup_tipoff_members DROP CONSTRAINT IF EXISTS lineup_tipoff_members_dispatch_fkey;
ALTER TABLE public.lineup_tipoff_dispatches DROP CONSTRAINT IF EXISTS lineup_tipoff_dispatches_pkey;
ALTER TABLE public.lineup_tipoff_dispatches ADD PRIMARY KEY (tipoff_at, scope);
ALTER TABLE public.lineup_tipoff_members DROP CONSTRAINT IF EXISTS lineup_tipoff_members_pkey;
ALTER TABLE public.lineup_tipoff_members ADD PRIMARY KEY (tipoff_at, scope, league_id, league_season_id, member_id, input_revision);
ALTER TABLE public.lineup_tipoff_members ADD CONSTRAINT lineup_tipoff_members_dispatch_fkey FOREIGN KEY (tipoff_at, scope) REFERENCES public.lineup_tipoff_dispatches(tipoff_at, scope);

INSERT INTO private.work_kinds(kind, function_name) VALUES ('pre-tipoff-policy','lineup-optimizer')
ON CONFLICT (kind) DO UPDATE SET function_name=EXCLUDED.function_name;

DROP FUNCTION IF EXISTS public.claim_lineup_tipoff_dispatch(timestamptz, uuid);
DROP FUNCTION IF EXISTS public.renew_lineup_tipoff_dispatch(timestamptz, uuid);
DROP FUNCTION IF EXISTS public.finish_lineup_tipoff_dispatch(timestamptz, uuid, text);
DROP FUNCTION IF EXISTS public.get_pending_tipoff_members(timestamptz, uuid, uuid[], int);
DROP FUNCTION IF EXISTS public.get_pending_auto_ir_members(date, timestamptz, uuid, uuid[], int, boolean);
DROP FUNCTION IF EXISTS public.mark_tipoff_ir_member_done(timestamptz, uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.record_pre_tipoff_lineup_failure(timestamptz, uuid, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.apply_pre_tipoff_lineup(timestamptz, uuid, uuid, uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.claim_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_scope text DEFAULT NULL)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date date;
BEGIN
  IF p_scope IS NULL AND EXISTS (
    SELECT 1 FROM public.lineup_tipoff_dispatches
     WHERE tipoff_at = p_tipoff_at AND token = p_token AND scope <> ''
  ) THEN
    RAISE EXCEPTION 'Tipoff claim requires its work scope.' USING ERRCODE = 'PT409';
  END IF;
  UPDATE public.lineup_tipoff_dispatches
     SET status = 'running', lease_until = now() + interval '45 seconds'
   WHERE tipoff_at = p_tipoff_at AND scope = COALESCE(p_scope, '') AND token = p_token AND status = 'queued'
     AND lease_until > clock_timestamp()
     AND game_date = (now() AT TIME ZONE 'America/New_York')::date
     AND tipoff_at > now() - interval '1 minute'
  RETURNING game_date INTO v_date;
  RETURN v_date;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_lineup_tipoff_dispatch(p_tipoff_at timestamptz,p_token uuid,p_scope text DEFAULT '')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.lineup_tipoff_dispatches SET lease_until=clock_timestamp()+interval '45 seconds'
  WHERE tipoff_at=p_tipoff_at AND scope=p_scope AND token=p_token AND status='running' AND lease_until>clock_timestamp()
    AND game_date=(clock_timestamp() AT TIME ZONE 'America/New_York')::date
    AND tipoff_at>clock_timestamp()-interval '1 minute';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_error text DEFAULT NULL, p_scope text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.lineup_tipoff_dispatches
     SET status = CASE WHEN p_error IS NULL THEN 'succeeded' ELSE 'failed' END,
         error = p_error, finished_at = now()
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND token = p_token AND status = 'running' AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pending_tipoff_members(
  p_tipoff_at timestamptz,p_token uuid,p_excluded_members uuid[] DEFAULT ARRAY[]::uuid[],p_limit int DEFAULT 100,p_scope text DEFAULT ''
)
RETURNS TABLE(league_id uuid,league_season_id uuid,member_id uuid,auto_ir boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit<1 THEN RAISE EXCEPTION 'Tipoff batch size must be positive' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
    WHERE tipoff_at=p_tipoff_at AND scope=p_scope AND token=p_token AND status='running'
      AND lease_until>clock_timestamp() AND tipoff_at>clock_timestamp()-interval '1 minute'
      AND game_date=(clock_timestamp() AT TIME ZONE 'America/New_York')::date FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
  RETURN QUERY SELECT setting.league_id,setting.league_season_id,setting.member_id,
    private.league_auto_ir_all_members(setting.league_id)
  FROM public.lineup_optimizer_settings setting
  JOIN public.league_seasons season ON season.id=setting.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=setting.league_id AND league.status IN ('active','playoffs')
  WHERE setting.enabled AND NOT (setting.member_id=ANY(COALESCE(p_excluded_members,ARRAY[]::uuid[])))
    AND (CASE WHEN p_scope='' THEN NOT private.league_auto_ir_all_members(setting.league_id)
      ELSE setting.league_id=p_scope::uuid END)
    AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date=v_dispatch.game_date AND game.game_time=p_tipoff_at)
    AND NOT EXISTS(SELECT 1 FROM public.lineup_tipoff_members done WHERE done.tipoff_at=p_tipoff_at
      AND done.scope=p_scope AND done.league_id=setting.league_id AND done.league_season_id=setting.league_season_id
      AND done.member_id=setting.member_id AND done.input_revision=v_dispatch.input_revision)
  ORDER BY setting.last_optimized_at NULLS FIRST,setting.league_id,setting.league_season_id,setting.member_id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pending_auto_ir_members(
  p_game_date date,
  p_tipoff_at timestamptz DEFAULT NULL,
  p_token uuid DEFAULT NULL,
  p_excluded_members uuid[] DEFAULT ARRAY[]::uuid[],
  p_limit int DEFAULT 100,
  p_include_enabled boolean DEFAULT false,
  p_scope text DEFAULT ''
)
RETURNS TABLE(league_id uuid, league_season_id uuid, member_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'Auto IR batch size must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_game_date IS DISTINCT FROM (now() AT TIME ZONE 'America/New_York')::date THEN RETURN; END IF;
  IF p_tipoff_at IS NOT NULL THEN
    SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
      WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND token = p_token AND status = 'running'
        AND lease_until > clock_timestamp() AND tipoff_at > clock_timestamp() - interval '1 minute'
        AND game_date = p_game_date FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE = '40001'; END IF;
  END IF;
  RETURN QUERY
  SELECT member.league_id, season.id, member.id
  FROM public.league_members member
  JOIN public.leagues league ON league.id = member.league_id AND league.status IN ('active', 'playoffs')
  JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
  JOIN private.league_roster_policies policy ON policy.league_id = league.id
    AND policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
  LEFT JOIN public.lineup_optimizer_settings setting
    ON setting.league_id = member.league_id AND setting.league_season_id = season.id
   AND setting.member_id = member.id
  WHERE (p_include_enabled OR NOT COALESCE(setting.enabled, false))
    AND NOT (member.id = ANY(COALESCE(p_excluded_members, ARRAY[]::uuid[])))
    AND (p_tipoff_at IS NULL
      OR (p_scope = '' AND NOT private.league_auto_ir_all_members(member.league_id))
      OR (p_scope <> '' AND member.league_id = p_scope::uuid))
    AND (p_tipoff_at IS NULL OR EXISTS (
      SELECT 1 FROM public.nba_games game
      WHERE game.season_year = season.season_year AND game.game_date = p_game_date
        AND game.status = 'Scheduled'
        AND private.lineup_game_available(game.status, game.game_status_text)
        AND game.game_time = p_tipoff_at
    ))
    AND (p_tipoff_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.lineup_tipoff_members done
      WHERE done.tipoff_at = p_tipoff_at AND done.scope = p_scope AND done.league_id = member.league_id
        AND done.league_season_id = season.id AND done.member_id = member.id
        AND done.input_revision = v_dispatch.input_revision
    ))
  ORDER BY member.id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_tipoff_ir_member_done(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_scope text DEFAULT ''
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token IS DISTINCT FROM p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;
  IF p_tipoff_at <= now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Tipoff window has closed.' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.league_members member
    JOIN public.leagues league ON league.id = member.league_id AND league.status IN ('active', 'playoffs')
    JOIN public.league_seasons season ON season.id = p_league_season_id
      AND season.league_id = league.id AND season.is_current
    WHERE member.id = p_member_id AND member.league_id = p_league_id
      AND private.league_auto_ir_all_members(p_league_id)
  ) THEN
    RAISE EXCEPTION 'Auto IR member not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.lineup_tipoff_members(tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
  VALUES(p_tipoff_at, p_scope, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision)
  ON CONFLICT (tipoff_at, scope, league_id, league_season_id, member_id, input_revision) DO NOTHING;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at AND scope = p_scope;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_pre_tipoff_lineup_failure(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_error text, p_scope text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_error IS NULL OR btrim(p_error) = '' THEN
    RAISE EXCEPTION 'A member failure requires an error.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token IS DISTINCT FROM p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lineup_optimizer_settings
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id)
     AND NOT (private.league_auto_ir_all_members(p_league_id) AND EXISTS (
       SELECT 1 FROM public.league_members member
       WHERE member.id = p_member_id AND member.league_id = p_league_id)) THEN
    RAISE EXCEPTION 'Optimizer setting not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.lineup_tipoff_members(tipoff_at, scope, league_id, league_season_id, member_id, input_revision, error)
  VALUES(p_tipoff_at, p_scope, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision, left(p_error, 4000))
  ON CONFLICT (tipoff_at, scope, league_id, league_season_id, member_id, input_revision) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_pre_tipoff_lineup(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_assignments jsonb, p_scope text DEFAULT ''
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
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token <> p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.lineup_tipoff_members
    WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND member_id = p_member_id
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
  INSERT INTO public.lineup_tipoff_members (tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
  VALUES (p_tipoff_at, p_scope, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision);
  UPDATE public.lineup_optimizer_settings SET last_optimized_at = now()
   WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at AND scope = p_scope;
  END IF;
  RETURN NOT v_same;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_lineup_tipoff_dispatch(timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_lineup_tipoff_dispatch(timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_lineup_tipoff_dispatch(timestamptz, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_pending_tipoff_members(timestamptz, uuid, uuid[], integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_pending_auto_ir_members(date, timestamptz, uuid, uuid[], integer, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_tipoff_ir_member_done(timestamptz, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_pre_tipoff_lineup_failure(timestamptz, uuid, uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_pre_tipoff_lineup(timestamptz, uuid, uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lineup_tipoff_dispatch(timestamptz, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_lineup_tipoff_dispatch(timestamptz, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_lineup_tipoff_dispatch(timestamptz, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_tipoff_members(timestamptz, uuid, uuid[], integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_auto_ir_members(date, timestamptz, uuid, uuid[], integer, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_tipoff_ir_member_done(timestamptz, uuid, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_pre_tipoff_lineup_failure(timestamptz, uuid, uuid, uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_pre_tipoff_lineup(timestamptz, uuid, uuid, uuid, uuid, jsonb, text) TO service_role;

CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz; v_scope text; v_chunk jsonb; v_claim jsonb; v_started timestamptz;
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
  IF v_item.kind IN ('pre-tipoff','pre-tipoff-policy') THEN
    v_tipoff:=(v_payload->>'tipoffAt')::timestamptz;
    v_scope:=COALESCE(v_payload->>'leagueId','');
    IF v_tipoff<=now()-interval '1 minute' THEN RAISE EXCEPTION 'Tipoff window has closed'; END IF;
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,scope,game_date) VALUES(v_tipoff,v_scope,(v_tipoff AT TIME ZONE 'America/New_York')::date) ON CONFLICT DO NOTHING;
    UPDATE public.lineup_tipoff_dispatches SET status='queued',token=p_token,attempts=attempts+1,
      lease_until=v_item.lease_until,error=NULL,input_revision=input_revision+(input_fingerprint IS DISTINCT FROM v_payload->>'fingerprint')::int,
      input_fingerprint=v_payload->>'fingerprint' WHERE tipoff_at=v_tipoff AND scope=v_scope;
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
      lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+CASE WHEN item.kind='pre-tipoff-policy' THEN interval '45 seconds' ELSE interval '5 minutes' END,
      invocation_key=NULL
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

CREATE OR REPLACE FUNCTION private.work_finish(p_id bigint, p_token uuid, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  UPDATE private.work_items SET
    status=CASE WHEN p_error IS NULL THEN 'succeeded'
      WHEN kind='pre-tipoff-policy' AND (payload->>'tipoffAt')::timestamptz > now() THEN 'failed'
      WHEN attempts>=3 THEN 'dead' ELSE 'failed' END,
    due_at=CASE WHEN p_error IS NULL THEN due_at
      WHEN kind='pre-tipoff-policy' THEN now()+interval '5 seconds'
      ELSE now()+make_interval(secs=>least(900,60*power(2,greatest(attempts-1,0))::int)) END,
    completed_at=CASE WHEN p_error IS NULL THEN now()
      WHEN kind='pre-tipoff-policy' AND (payload->>'tipoffAt')::timestamptz > now() THEN NULL
      WHEN attempts>=3 THEN now() ELSE NULL END,
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

CREATE OR REPLACE FUNCTION public.renew_work_lease(p_invocation_key uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  WITH unlocked AS (
    SELECT id FROM private.work_items WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp()
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.work_items item SET lease_until=clock_timestamp()+
      CASE WHEN item.kind='pre-tipoff-policy' THEN interval '45 seconds' ELSE interval '5 minutes' END
  FROM unlocked WHERE item.id=unlocked.id;
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM private.work_items WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp());
END;
$$;

CREATE OR REPLACE FUNCTION public.start_work_invocation(
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
  IF v_inv.work_item_id IS NULL THEN
    RAISE EXCEPTION 'Invocation has no work lease' USING ERRCODE='PT409';
  END IF;
  WITH unlocked AS (
    SELECT id FROM private.work_items WHERE id=v_inv.work_item_id AND lease_token=v_inv.work_lease_token
      AND invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp()
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.work_items item SET lease_until=clock_timestamp()+
      CASE WHEN item.kind='pre-tipoff-policy' THEN interval '45 seconds' ELSE interval '5 minutes' END
    FROM unlocked WHERE item.id=unlocked.id;
  IF NOT FOUND AND NOT EXISTS(
    SELECT 1 FROM private.work_items WHERE id=v_inv.work_item_id AND lease_token=v_inv.work_lease_token
      AND invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp()
  ) THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.sync_runs (function_name, started_at)
  VALUES (p_function_name, clock_timestamp()) RETURNING id INTO v_run;
  UPDATE public.edge_invocations
     SET worker_started_at = clock_timestamp(), worker_status = 'running', sync_run_id = v_run
   WHERE id = v_inv.id;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_pre_tipoff_optimizer(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_window record; v_fingerprint text; v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_attempt int;
BEGIN
  FOR v_window IN
    SELECT tipoff_at, league_id FROM (
    SELECT DISTINCT g.game_time AS tipoff_at, NULL::uuid AS league_id
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
           AND NOT private.league_auto_ir_all_members(s.league_id)
       )
    UNION
    SELECT DISTINCT g.game_time AS tipoff_at, policy.league_id
      FROM public.nba_games g
      JOIN public.league_seasons ls ON ls.season_year = g.season_year AND ls.is_current
      JOIN public.leagues l ON l.id = ls.league_id AND l.status IN ('active', 'playoffs')
      JOIN private.league_roster_policies policy ON policy.league_id = l.id
        AND policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
     WHERE g.game_date = v_today
       AND g.status = 'Scheduled'
       AND private.lineup_game_available(g.status, g.game_status_text)
       AND g.game_time > p_now
       AND g.game_time <= p_now + interval '2 minutes'
       AND (g.started_at IS NULL OR g.started_at > p_now)
    UNION
    SELECT d.tipoff_at, NULLIF(d.scope,'')::uuid
      FROM public.lineup_tipoff_dispatches d
     WHERE d.game_date = v_today AND d.tipoff_at > p_now - interval '1 minute'
       AND d.tipoff_at <= p_now + interval '2 minutes'
    ) windows ORDER BY tipoff_at, league_id NULLS FIRST
  LOOP
    IF v_fingerprint IS NULL THEN v_fingerprint:=private.pre_tipoff_input_fingerprint(v_today); END IF;
    IF v_window.league_id IS NULL THEN
      IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND scope='' AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
      SELECT count(*) INTO v_attempt FROM private.work_items item
       WHERE item.kind='pre-tipoff' AND (item.payload->>'tipoffAt')::timestamptz=v_window.tipoff_at;
      PERFORM private.work_enqueue('pre-tipoff',v_window.tipoff_at::text||':'||v_fingerprint||':'||v_attempt::text,p_now,
        jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'fingerprint',v_fingerprint));
    ELSE
      IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND scope=v_window.league_id::text AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
      SELECT count(*) INTO v_attempt FROM private.work_items item
       WHERE item.kind='pre-tipoff-policy' AND (item.payload->>'tipoffAt')::timestamptz=v_window.tipoff_at AND item.payload->>'leagueId'=v_window.league_id::text;
      PERFORM private.work_enqueue('pre-tipoff-policy',v_window.tipoff_at::text||':'||v_window.league_id::text||':'||v_fingerprint||':'||v_attempt::text,p_now,
        jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'leagueId',v_window.league_id,'fingerprint',v_fingerprint));
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_dispatches(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.tipoff_at, r.scope FROM public.lineup_tipoff_dispatches r
    WHERE r.status IN ('succeeded','failed') AND r.finished_at<p_now-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM public.lineup_tipoff_members m WHERE m.tipoff_at=r.tipoff_at AND m.scope=r.scope)
    ORDER BY r.tipoff_at, r.scope LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.lineup_tipoff_dispatches r USING victims v WHERE r.tipoff_at=v.tipoff_at AND r.scope=v.scope;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.lineup_tipoff_dispatches',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_members(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.ctid FROM public.lineup_tipoff_members r
    WHERE r.tipoff_at<p_now-interval '30 days'
      AND EXISTS (SELECT 1 FROM public.lineup_tipoff_dispatches d WHERE d.tipoff_at=r.tipoff_at AND d.scope=r.scope
        AND d.status IN ('succeeded','failed') AND d.finished_at<p_now-interval '30 days')
    ORDER BY r.tipoff_at,r.scope,r.league_id,r.league_season_id,r.member_id,r.input_revision LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.lineup_tipoff_members r USING victims v WHERE r.ctid=v.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.lineup_tipoff_members',v_count);
END;
$$;
