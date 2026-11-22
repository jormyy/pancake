ALTER TABLE public.lineup_tipoff_members ADD COLUMN IF NOT EXISTS ir_done boolean NOT NULL DEFAULT false;
ALTER TABLE public.lineup_tipoff_members ADD COLUMN IF NOT EXISTS starter_done boolean NOT NULL DEFAULT false;

UPDATE public.lineup_tipoff_members
   SET ir_done = true, starter_done = true
 WHERE error IS NULL AND NOT (ir_done AND starter_done);


CREATE OR REPLACE FUNCTION private.pre_tipoff_input_fingerprint(p_game_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH teams AS MATERIALIZED (
    SELECT s.league_id, s.league_season_id, s.member_id, ls.season_year, l.scoring_settings
    FROM public.lineup_optimizer_settings s
    JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
    JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
    WHERE s.enabled AND NOT private.league_auto_ir_all_members(s.league_id) AND EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = ls.season_year
    )
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'pins', (SELECT jsonb_agg(to_jsonb(pin) ORDER BY pin.league_id, pin.member_id, pin.player_id)
      FROM public.lineup_player_pins pin JOIN teams t ON t.league_id = pin.league_id
        AND t.league_season_id = pin.league_season_id AND t.member_id = pin.member_id
      WHERE pin.game_date = p_game_date),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id IN (SELECT league_id FROM teams)),
    'games', (SELECT jsonb_agg(jsonb_build_array(g.id, g.game_date, g.game_time, g.home_team,
        g.away_team, private.lineup_game_available(g.status, g.game_status_text)) ORDER BY g.id)
      FROM public.nba_games g WHERE g.game_date = p_game_date),
    'projections', (SELECT jsonb_agg(jsonb_build_array(t.league_id,
        to_jsonb(p)-'projection_fetched_at') ORDER BY t.league_id,p.player_id)
      FROM (SELECT DISTINCT league_id,season_year FROM teams) t CROSS JOIN LATERAL public.get_league_projection_rows(t.league_id,t.season_year,
        p_game_date,'today',ARRAY(SELECT DISTINCT r.player_id FROM roster r
          WHERE r.league_id=t.league_id),1000,0) p)
  )::text);
$$;


CREATE OR REPLACE FUNCTION private.pre_tipoff_policy_input_fingerprint(p_game_date date, p_league_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH league AS MATERIALIZED (
    SELECT l.id AS league_id, ls.id AS league_season_id, ls.season_year,
      l.scoring_settings, l.roster_size, l.ir_slots
    FROM public.leagues l
    JOIN public.league_seasons ls ON ls.league_id = l.id AND ls.is_current
    WHERE l.id = p_league_id AND l.status IN ('active', 'playoffs')
      AND private.league_auto_ir_all_members(l.id)
  ), teams AS MATERIALIZED (
    SELECT member.league_id, league.league_season_id, member.id AS member_id,
      league.season_year, league.scoring_settings, league.roster_size, league.ir_slots,
      COALESCE(setting.enabled, false) AS optimizer_enabled
    FROM public.league_members member
    JOIN league ON league.league_id = member.league_id
    LEFT JOIN public.lineup_optimizer_settings setting
      ON setting.league_id = member.league_id AND setting.league_season_id = league.league_season_id
     AND setting.member_id = member.id
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, p.injury_expected_return,
      p.career_regular_season_games, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'locks', (SELECT jsonb_agg(jsonb_build_array(t.league_id, t.member_id, la.asset_kind, la.asset_id,
        la.source_kind, la.source_id) ORDER BY t.league_id, t.member_id, la.asset_kind, la.asset_id)
      FROM teams t CROSS JOIN LATERAL private.locked_assets(t.league_id, t.league_season_id, t.member_id) la),
    'pins', (SELECT jsonb_agg(to_jsonb(pin) ORDER BY pin.league_id, pin.member_id, pin.player_id)
      FROM public.lineup_player_pins pin JOIN teams t ON t.league_id = pin.league_id
        AND t.league_season_id = pin.league_season_id AND t.member_id = pin.member_id
      WHERE pin.game_date = p_game_date),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id = p_league_id),
    'games', (SELECT jsonb_agg(jsonb_build_array(g.id, g.game_date, g.game_time, g.home_team,
        g.away_team, private.lineup_game_available(g.status, g.game_status_text)) ORDER BY g.id)
      FROM public.nba_games g WHERE g.game_date = p_game_date),
    'projections', (SELECT jsonb_agg(jsonb_build_array(t.league_id,
        to_jsonb(p)-'projection_fetched_at') ORDER BY t.league_id,p.player_id)
      FROM (SELECT DISTINCT league_id,season_year FROM teams) t CROSS JOIN LATERAL public.get_league_projection_rows(t.league_id,t.season_year,
        p_game_date,'today',ARRAY(SELECT DISTINCT r.player_id FROM roster r
          WHERE r.league_id=t.league_id),1000,0) p)
  )::text);
$$;

REVOKE ALL ON FUNCTION private.pre_tipoff_policy_input_fingerprint(date, uuid) FROM PUBLIC, anon, authenticated, service_role;


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
    IF v_window.league_id IS NULL THEN
      v_fingerprint := private.pre_tipoff_input_fingerprint(v_today);
      IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND scope='' AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
      SELECT count(*) INTO v_attempt FROM private.work_items item
       WHERE item.kind='pre-tipoff' AND (item.payload->>'tipoffAt')::timestamptz=v_window.tipoff_at;
      PERFORM private.work_enqueue('pre-tipoff',v_window.tipoff_at::text||':'||v_fingerprint||':'||v_attempt::text,p_now,
        jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'fingerprint',v_fingerprint));
    ELSE
      IF NOT private.league_auto_ir_all_members(v_window.league_id) THEN CONTINUE; END IF;
      v_fingerprint := private.pre_tipoff_policy_input_fingerprint(v_today, v_window.league_id);
      IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND scope=v_window.league_id::text AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
      SELECT count(*) INTO v_attempt FROM private.work_items item
       WHERE item.kind='pre-tipoff-policy' AND (item.payload->>'tipoffAt')::timestamptz=v_window.tipoff_at AND item.payload->>'leagueId'=v_window.league_id::text;
      PERFORM private.work_enqueue('pre-tipoff-policy',v_window.tipoff_at::text||':'||v_window.league_id::text||':'||v_fingerprint||':'||v_attempt::text,p_now,
        jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'leagueId',v_window.league_id,'fingerprint',v_fingerprint));
    END IF;
  END LOOP;
END;
$$;


CREATE OR REPLACE FUNCTION private.tipoff_scope_admits(
  p_scope text,
  p_league_id uuid,
  p_lock boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active boolean;
BEGIN
  IF p_lock THEN
    SELECT (policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL)
      INTO v_active
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
     FOR SHARE;
  ELSE
    SELECT (policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL)
      INTO v_active
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id;
  END IF;
  v_active := COALESCE(v_active, false);
  IF p_scope = '' THEN
    RETURN NOT v_active;
  END IF;
  RETURN p_scope = p_league_id::text AND v_active;
END;
$$;


CREATE OR REPLACE FUNCTION public.auto_manage_ir_tipoff_service(
  p_tipoff_at timestamptz,
  p_token uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_scope text DEFAULT ''
)
RETURNS jsonb
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
  IF NOT private.tipoff_scope_admits(p_scope, p_league_id, true) THEN
    RAISE EXCEPTION 'Tipoff scope is no longer active.' USING ERRCODE = 'PT410';
  END IF;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at AND scope = p_scope;
  END IF;
  RETURN public.auto_manage_ir_service(p_league_id, p_league_season_id, p_member_id);
END;
$$;


CREATE OR REPLACE FUNCTION public.claim_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_scope text DEFAULT NULL)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date date;
  v_scope text := COALESCE(p_scope, '');
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_scope IS NULL AND EXISTS (
    SELECT 1 FROM public.lineup_tipoff_dispatches
     WHERE tipoff_at = p_tipoff_at AND token = p_token AND scope <> ''
  ) THEN
    RAISE EXCEPTION 'Tipoff claim requires its work scope.' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = v_scope AND token = p_token AND status = 'queued'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_scope <> '' AND NOT private.tipoff_scope_admits(v_scope, v_scope::uuid, true) THEN
    UPDATE public.lineup_tipoff_dispatches
       SET status = 'failed', error = 'Tipoff scope is no longer active.', finished_at = now()
     WHERE tipoff_at = p_tipoff_at AND scope = v_scope AND token = p_token AND status = 'queued';
    RETURN NULL;
  END IF;
  UPDATE public.lineup_tipoff_dispatches
     SET status = 'running', lease_until = now() + interval '45 seconds'
   WHERE tipoff_at = p_tipoff_at AND scope = v_scope AND token = p_token AND status = 'queued'
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
  IF p_scope <> '' AND NOT private.tipoff_scope_admits(p_scope, p_scope::uuid) THEN
    RETURN false;
  END IF;
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
DECLARE
  v_admitted boolean := true;
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND token = p_token
     AND status = 'running' AND lease_until > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
  IF p_scope <> '' THEN
    v_admitted := private.tipoff_scope_admits(p_scope, p_scope::uuid, true);
  END IF;
  UPDATE public.lineup_tipoff_dispatches
     SET status = CASE WHEN p_error IS NULL AND v_admitted THEN 'succeeded' ELSE 'failed' END,
         error = CASE WHEN p_error IS NULL AND NOT v_admitted THEN 'Tipoff scope is no longer active.' ELSE p_error END,
         finished_at = now()
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND token = p_token AND status = 'running' AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
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
  IF NOT private.tipoff_scope_admits(p_scope, p_league_id, true) THEN
    RAISE EXCEPTION 'Tipoff scope is no longer active.' USING ERRCODE = 'PT410';
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
  INSERT INTO public.lineup_tipoff_members(tipoff_at, scope, league_id, league_season_id, member_id, input_revision, ir_done)
  VALUES(p_tipoff_at, p_scope, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision, true)
  ON CONFLICT (tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
  DO UPDATE SET ir_done = true;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at AND scope = p_scope;
  END IF;
  RETURN true;
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

  IF NOT private.tipoff_scope_admits(p_scope, p_league_id, true) THEN
    IF p_scope = '' THEN RETURN false; END IF;
    RAISE EXCEPTION 'Tipoff scope is no longer active.' USING ERRCODE = 'PT410';
  END IF;

  IF EXISTS (SELECT 1 FROM public.lineup_tipoff_members
    WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND member_id = p_member_id
      AND league_id = p_league_id AND league_season_id = p_league_season_id
      AND input_revision = v_dispatch.input_revision
      AND (starter_done OR error IS NOT NULL)) THEN
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
  INSERT INTO public.lineup_tipoff_members (tipoff_at, scope, league_id, league_season_id, member_id, input_revision, starter_done)
  VALUES (p_tipoff_at, p_scope, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision, true)
  ON CONFLICT (tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
  DO UPDATE SET starter_done = true;
  UPDATE public.lineup_optimizer_settings SET last_optimized_at = now()
   WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at AND scope = p_scope;
  END IF;
  RETURN NOT v_same;
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
    AND private.tipoff_scope_admits(p_scope,setting.league_id)
    AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date=v_dispatch.game_date AND game.game_time=p_tipoff_at)
    AND NOT EXISTS(SELECT 1 FROM public.lineup_tipoff_members done WHERE done.tipoff_at=p_tipoff_at
      AND done.scope=p_scope AND done.league_id=setting.league_id AND done.league_season_id=setting.league_season_id
      AND done.member_id=setting.member_id AND done.input_revision=v_dispatch.input_revision
      AND (done.starter_done OR done.error IS NOT NULL))
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
    AND (p_tipoff_at IS NULL OR private.tipoff_scope_admits(p_scope, member.league_id))
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
        AND (done.ir_done OR done.error IS NOT NULL)
    ))
  ORDER BY member.id
  LIMIT p_limit;
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
  IF NOT private.tipoff_scope_admits(p_scope, p_league_id, true) THEN
    IF p_scope = '' THEN RETURN; END IF;
    RAISE EXCEPTION 'Tipoff scope is no longer active.' USING ERRCODE = 'PT410';
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
  ON CONFLICT (tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
  DO UPDATE SET error = CASE WHEN public.lineup_tipoff_members.starter_done
    THEN public.lineup_tipoff_members.error
    ELSE COALESCE(public.lineup_tipoff_members.error, EXCLUDED.error) END;
END;
$$;


REVOKE ALL ON FUNCTION private.tipoff_scope_admits(text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.tipoff_scope_admits(text, uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.auto_manage_ir_tipoff_service(timestamptz, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_manage_ir_tipoff_service(timestamptz, uuid, uuid, uuid, uuid, text) TO service_role;
