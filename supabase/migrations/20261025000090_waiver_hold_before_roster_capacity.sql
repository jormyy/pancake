CREATE OR REPLACE FUNCTION private.assert_free_agent_waiver_cleared(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.waiver_wire_log AS waiver
     WHERE waiver.league_id = p_league_id
       AND waiver.league_season_id = p_league_season_id
       AND waiver.player_id = p_player_id
       AND waiver.cleared_at IS NULL
  ) THEN
    RAISE EXCEPTION 'This player is on waivers - submit a waiver claim instead.'
      USING ERRCODE = 'PA002';
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION private.prevent_uncleared_waiver_free_agent_add()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.acquired_via = 'free_agent' THEN
    PERFORM private.assert_free_agent_waiver_cleared(NEW.league_id, NEW.league_season_id, NEW.player_id);
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid,
  p_to_ir boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_active_count int;
  v_existing_roster_id uuid;
  v_ineligible text;
  v_ir_count int;
  v_injury text;
BEGIN
  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player - you may not have permission for this league.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_player_id::text));

  v_ineligible := private.ineligible_ir_player_names(p_league_id, v_season_id, p_member_id);
  IF v_ineligible IS NOT NULL THEN
    RAISE EXCEPTION 'You have ineligible players on IR (%). Activate or drop them before adding players.', v_ineligible
      USING ERRCODE = 'PA005';
  END IF;

  SELECT id
    INTO v_existing_roster_id
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
   FOR UPDATE;

  IF v_existing_roster_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is already on a roster.'
      USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Free-agent adds require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Free-agent adds require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_free_agent_waiver_cleared(p_league_id, v_season_id, p_player_id);

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF p_to_ir THEN
    IF v_league.status = 'offseason'::league_status THEN
      RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT injury_status INTO v_injury FROM players WHERE id = p_player_id FOR SHARE;
    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'PA006';
    END IF;
    SELECT count(*) INTO v_ir_count FROM roster_players
     WHERE member_id = p_member_id AND league_season_id = v_season_id AND is_on_ir;
    IF v_ir_count >= COALESCE(v_league.ir_slots, 2) THEN
      RAISE EXCEPTION 'Your IR slots are full (% slots).', COALESCE(v_league.ir_slots, 2)
        USING ERRCODE = 'PA007';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF NOT COALESCE(p_to_ir, false) AND v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
      USING ERRCODE = 'PA003';
  END IF;

  INSERT INTO roster_players (
    member_id,
    league_id,
    league_season_id,
    player_id,
    acquired_via,
    is_on_ir
  )
  VALUES (
    p_member_id,
    p_league_id,
    v_season_id,
    p_player_id,
    'free_agent',
    COALESCE(p_to_ir, false)
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    'fa_add'
  );

  PERFORM private.consume_weekly_add(p_league_id, v_season_id, p_member_id);

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'free_agent_added',
    'Free agent added',
    NULL,
    p_member_id,
    p_member_id,
    p_player_id,
    NULL,
    NULL,
    '{}'::jsonb
  );
END;
$$;

ALTER FUNCTION private.assert_free_agent_waiver_cleared(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.assert_free_agent_waiver_cleared(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.assert_free_agent_waiver_cleared(uuid, uuid, uuid) TO postgres, service_role;
