BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.lineup_tipoff_dispatches (
  tipoff_at timestamptz PRIMARY KEY,
  game_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'running', 'succeeded', 'failed')),
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts integer NOT NULL DEFAULT 0,
  input_revision integer NOT NULL DEFAULT 0,
  input_fingerprint text,
  lease_until timestamptz,
  finished_at timestamptz,
  error text
);
CREATE TABLE public.lineup_tipoff_members (
  tipoff_at timestamptz NOT NULL REFERENCES public.lineup_tipoff_dispatches(tipoff_at),
  league_id uuid NOT NULL,
  league_season_id uuid NOT NULL,
  member_id uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  input_revision integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tipoff_at, league_id, league_season_id, member_id, input_revision)
);
ALTER TABLE public.lineup_tipoff_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lineup_tipoff_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lineup_tipoff_dispatches, public.lineup_tipoff_members FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.lineup_tipoff_dispatches, public.lineup_tipoff_members TO service_role;
CREATE INDEX nba_games_pre_tipoff_idx ON public.nba_games(game_date, game_time) WHERE status = 'Scheduled' AND started_at IS NULL;

CREATE OR REPLACE FUNCTION private.lineup_game_available(p_status text, p_status_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_status IN ('Scheduled', 'InProgress', 'Final')
    AND COALESCE(p_status_text, '') !~* 'postpon|cancel|suspend|(^|[^a-z])ppd([^a-z]|$)';
$$;

REVOKE ALL ON FUNCTION private.lineup_game_available(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.lineup_game_available(text, text) TO service_role;

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
    WHERE s.enabled AND EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = ls.season_year
    )
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  ), ids AS MATERIALIZED (SELECT DISTINCT player_id FROM roster)
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id IN (SELECT league_id FROM teams)),
    'games', (SELECT jsonb_agg(jsonb_build_array(g.id, g.game_date, g.game_time, g.home_team,
        g.away_team, private.lineup_game_available(g.status, g.game_status_text)) ORDER BY g.id)
      FROM public.nba_games g WHERE g.game_date = p_game_date),
    'fantasypros', (SELECT jsonb_agg(jsonb_build_array(to_jsonb(r),
        r.fetched_at >= now() - interval '36 hours', r.fetched_at >= now() - interval '8 days') ORDER BY r.id)
      FROM public.fantasypros_projection_rows r JOIN ids ON ids.player_id = r.player_id
      WHERE r.projection_date = p_game_date OR r.projection_type <> 'daily'
        AND r.season_year IN (SELECT season_year FROM teams)),
    'runs', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.projection_sync_runs r
      WHERE r.projection_date = p_game_date OR r.projection_type <> 'daily'
        AND r.season_year IN (SELECT season_year FROM teams)),
    'internal', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
      FROM public.player_projections p JOIN ids ON ids.player_id = p.player_id
      WHERE p.season_year IN (SELECT season_year FROM teams)),
    'averages', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.player_id, a.season_year)
      FROM public.mv_player_season_averages a JOIN ids ON ids.player_id = a.player_id
      WHERE a.season_year IN (SELECT season_year FROM teams))
  )::text);
$$;

REVOKE ALL ON FUNCTION private.pre_tipoff_input_fingerprint(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.pre_tipoff_input_fingerprint(date) TO service_role;


CREATE OR REPLACE FUNCTION public.invoke_pre_tipoff_optimizer_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window record;
  v_token uuid;
  v_fingerprint text;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  FOR v_window IN
    SELECT tipoff_at FROM (
    SELECT DISTINCT g.game_time AS tipoff_at
      FROM public.nba_games g
     WHERE g.game_date = v_today
       AND g.status = 'Scheduled'
       AND private.lineup_game_available(g.status, g.game_status_text)
       AND g.game_time > now()
       AND g.game_time <= now() + interval '2 minutes'
       AND g.started_at IS NULL
       AND EXISTS (
         SELECT 1 FROM public.lineup_optimizer_settings s
         JOIN public.league_seasons ls ON ls.id = s.league_season_id
         JOIN public.leagues l ON l.id = s.league_id
         WHERE s.enabled AND ls.is_current AND ls.season_year = g.season_year
           AND l.status IN ('active', 'playoffs')
       )
    UNION
    SELECT d.tipoff_at FROM public.lineup_tipoff_dispatches d
    WHERE d.game_date = v_today AND d.tipoff_at > now() - interval '1 minute'
      AND d.tipoff_at <= now() + interval '2 minutes'
    ) windows ORDER BY tipoff_at
  LOOP
    IF v_fingerprint IS NULL THEN
      v_fingerprint := private.pre_tipoff_input_fingerprint(v_today);
    END IF;
    v_token := NULL;
    INSERT INTO public.lineup_tipoff_dispatches (tipoff_at, game_date)
    VALUES (v_window.tipoff_at, v_today)
    ON CONFLICT (tipoff_at) DO NOTHING;

    UPDATE public.lineup_tipoff_dispatches
       SET status = 'queued', token = gen_random_uuid(), attempts = attempts + 1,
           lease_until = now() + interval '45 seconds', error = NULL,
           input_revision = input_revision + (input_fingerprint IS DISTINCT FROM v_fingerprint)::int,
           input_fingerprint = v_fingerprint
     WHERE tipoff_at = v_window.tipoff_at
       AND (status = 'pending' OR status = 'failed'
         OR (status IN ('queued', 'running') AND lease_until <= now())
         OR (status = 'succeeded' AND input_fingerprint IS DISTINCT FROM v_fingerprint))
    RETURNING token INTO v_token;

    IF v_token IS NOT NULL THEN
      BEGIN
        PERFORM public.invoke_edge_function('lineup-optimizer', jsonb_build_object(
          'mode', 'pre_tipoff', 'tipoffAt', v_window.tipoff_at, 'token', v_token
        ));
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.lineup_tipoff_dispatches SET status = 'failed', error = SQLERRM
         WHERE tipoff_at = v_window.tipoff_at AND token = v_token;
      END;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_pre_tipoff_optimizer_if_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_pre_tipoff_optimizer_if_due() TO service_role;

CREATE OR REPLACE FUNCTION public.claim_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date date;
BEGIN
  UPDATE public.lineup_tipoff_dispatches
     SET status = 'running', lease_until = now() + interval '45 seconds'
   WHERE tipoff_at = p_tipoff_at AND token = p_token AND status = 'queued'
     AND game_date = (now() AT TIME ZONE 'America/New_York')::date
     AND tipoff_at > now() - interval '1 minute'
  RETURNING game_date INTO v_date;
  RETURN v_date;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_lineup_tipoff_dispatch(timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lineup_tipoff_dispatch(timestamptz, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.lineup_tipoff_dispatches
     SET status = CASE WHEN p_error IS NULL THEN 'succeeded' ELSE 'failed' END,
         error = p_error, finished_at = now()
   WHERE tipoff_at = p_tipoff_at AND token = p_token AND status = 'running';
$$;

REVOKE ALL ON FUNCTION public.finish_lineup_tipoff_dispatch(timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_lineup_tipoff_dispatch(timestamptz, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_pre_tipoff_lineup_context(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'date', (now() AT TIME ZONE 'America/New_York')::date,
    'seasonYear', ls.season_year,
    'weekNumber', sw.week_number,
    'players', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'playerId', p.id, 'eligiblePositions', CASE WHEN cardinality(p.eligible_positions) > 0
          THEN p.eligible_positions ELSE ARRAY[p.position::text] END,
        'injuryStatus', p.injury_status,
        'locked', private.lineup_game_started(p.id, sw_date.game_date),
        'hasGame', EXISTS (SELECT 1 FROM public.nba_games g
          WHERE g.game_date = sw_date.game_date AND private.lineup_game_available(g.status, g.game_status_text)
            AND (g.home_team = p.nba_team OR g.away_team = p.nba_team))
      ) ORDER BY p.id)
      FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
      WHERE rp.league_id = p_league_id AND rp.league_season_id = p_league_season_id
        AND rp.member_id = p_member_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
    ), '[]'::jsonb),
    'templates', COALESCE((SELECT jsonb_agg(jsonb_build_object('slotType', slot_type, 'count', slot_count) ORDER BY slot_type)
      FROM public.lineup_slot_templates WHERE league_id = p_league_id
        AND slot_type NOT IN ('BE', 'IR')), '[]'::jsonb),
    'stored', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'player_id', wl.player_id, 'slot_type', wl.slot_type,
      'is_auto_set', wl.is_auto_set, 'week_number', wl.week_number,
      'locked', private.lineup_game_started(wl.player_id, wl.game_date)
    ) ORDER BY wl.player_id) FROM public.weekly_lineups wl
      WHERE wl.league_id = p_league_id AND wl.league_season_id = p_league_season_id
        AND wl.member_id = p_member_id AND wl.game_date = sw_date.game_date), '[]'::jsonb)
  )
  FROM public.lineup_optimizer_settings s
  JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
  JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
  CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE 'America/New_York')::date AS game_date) sw_date
  LEFT JOIN public.season_weeks sw ON sw.season_year = ls.season_year
    AND sw_date.game_date BETWEEN sw.week_start AND sw.week_end
  WHERE s.league_id = p_league_id AND s.league_season_id = p_league_season_id
    AND s.member_id = p_member_id AND s.enabled;
$$;

REVOKE ALL ON FUNCTION public.get_pre_tipoff_lineup_context(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pre_tipoff_lineup_context(uuid, uuid, uuid) TO service_role;

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

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_member_id::text), hashtext(v_dispatch.game_date::text));
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  PERFORM 1 FROM public.players WHERE id IN (
    SELECT (a->>'player_id')::uuid FROM jsonb_array_elements(p_assignments) a
  ) ORDER BY id FOR SHARE;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE (lower(p.injury_status) = 'out' OR lower(p.injury_status) LIKE 'ir%')
      AND NOT private.lineup_game_started(p.id, v_dispatch.game_date)
  ) THEN
    RAISE EXCEPTION 'Injury status changed; retry with fresh players.' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE NOT private.lineup_game_started(p.id, v_dispatch.game_date)
      AND NOT EXISTS (
        SELECT 1 FROM public.nba_games g
        WHERE g.game_date = v_dispatch.game_date
          AND private.lineup_game_available(g.status, g.game_status_text)
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
      )
  ) THEN
    RAISE EXCEPTION 'Game schedule changed; retry with fresh games.' USING ERRCODE = '40001';
  END IF;

  SELECT NOT EXISTS (
    (SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = v_dispatch.game_date
     EXCEPT SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a)
    UNION ALL
    (SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a
     EXCEPT SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = v_dispatch.game_date)
  ) INTO v_same;

  IF NOT v_same THEN
    PERFORM public.auto_set_lineup_service_atomic(p_member_id, p_league_id, p_league_season_id,
      v_dispatch.game_date, p_assignments);
  END IF;
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

REVOKE ALL ON FUNCTION public.apply_pre_tipoff_lineup(timestamptz, uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pre_tipoff_lineup(timestamptz, uuid, uuid, uuid, uuid, jsonb) TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-lineup-optimizer') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-lineup-optimizer'
    );
    PERFORM cron.schedule('nba-lineup-optimizer', '* * * * *',
      'SELECT public.invoke_pre_tipoff_optimizer_if_due()');
  END IF;
END
$cron$;
COMMIT;
