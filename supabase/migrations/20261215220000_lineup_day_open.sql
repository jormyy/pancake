BEGIN;

CREATE OR REPLACE FUNCTION private.assert_lineup_day_open(p_game_date date)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_game_date < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_lineup_day_open(date) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_lineup_player_pin(p_league_id uuid, p_player_id uuid, p_date date, p_pin text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member_id uuid;
  v_season_id uuid;
  v_roster public.roster_players%ROWTYPE;
BEGIN
  SELECT m.id, s.id
    INTO v_member_id, v_season_id
    FROM public.league_members m
    JOIN public.leagues l ON l.id = m.league_id AND l.deleted_at IS NULL
    JOIN public.league_seasons s ON s.league_id = l.id AND s.is_current
    WHERE m.league_id = p_league_id AND m.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;
  IF p_date IS NULL OR (p_pin IS NOT NULL AND p_pin NOT IN ('start', 'bench')) THEN
    RAISE EXCEPTION 'Choose Start, Auto, or Bench for a lineup date.' USING ERRCODE = '22023';
  END IF;
  PERFORM private.assert_lineup_day_open(p_date);
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[v_member_id], '{}');
  PERFORM pg_advisory_xact_lock(hashtext(v_member_id::text), hashtext(p_date::text));
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, v_season_id);
  SELECT * INTO v_roster FROM public.roster_players
    WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on your roster.' USING ERRCODE = 'P0002';
  END IF;
  IF v_roster.is_on_ir OR v_roster.is_on_taxi THEN
    RAISE EXCEPTION 'Activate this player before setting a lineup pin.' USING ERRCODE = 'P0001';
  END IF;
  IF private.lineup_game_started(p_player_id, p_date) THEN
    RAISE EXCEPTION 'Lineup changes are locked after this player''s game has started.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pin IS NULL THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id AND game_date = p_date;
  ELSE
    INSERT INTO public.lineup_player_pins(league_id, league_season_id, member_id, player_id, game_date, pin)
      VALUES (p_league_id, v_season_id, v_member_id, p_player_id, p_date, p_pin)
      ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
      DO UPDATE SET pin = EXCLUDED.pin WHERE lineup_player_pins.pin IS DISTINCT FROM EXCLUDED.pin;
  END IF;
  RETURN jsonb_build_object('playerId', p_player_id, 'date', p_date, 'lineupPin', p_pin);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_moves jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.set_player_slot_moves_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_game_date, p_week_number, p_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM 1 FROM public.league_members
  WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_moves) > 64 THEN
    RAISE EXCEPTION 'Too many lineup moves.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.assert_lineup_day_open(p_game_date);

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.set_player_slot_moves_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    p_moves
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
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

  PERFORM private.assert_lineup_day_open(p_game_date);

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

COMMIT;
