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
