-- Username and waiver-oracle closure:
-- - remove the public username availability oracle
-- - remove hidden pending-claim branching from client-callable free-agent adds

REVOKE ALL ON FUNCTION public.is_username_available(text) FROM PUBLIC;
DROP FUNCTION IF EXISTS public.is_username_available(text);

DROP POLICY IF EXISTS "waiver_wire_log_select_visible_league_rows" ON public.waiver_wire_log;
DROP POLICY IF EXISTS "waiver_wire_log_select" ON public.waiver_wire_log;

CREATE POLICY "waiver_wire_log_select" ON public.waiver_wire_log
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE OR REPLACE FUNCTION public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_active_count int;
  v_waiver_log_id uuid;
  v_existing_roster_id uuid;
  v_ineligible text;
BEGIN
  SELECT *
    INTO v_member
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
    RAISE EXCEPTION 'No active season found.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_league_id::text),
    hashtext(p_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(p_league_id::text),
    hashtext(p_player_id::text)
  );

  SELECT string_agg(COALESCE(p.display_name, 'Unknown'), ', ')
    INTO v_ineligible
    FROM roster_players rp
    JOIN players p ON p.id = rp.player_id
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = v_season_id
     AND rp.is_on_ir = true
     AND NOT (
       lower(COALESCE(p.injury_status, '')) = 'out'
       OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%'
     );

  IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
    RAISE EXCEPTION 'You have ineligible players on IR (%). Activate or drop them before adding players.',
      v_ineligible
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
    INTO v_waiver_log_id
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
   ORDER BY clears_at
   LIMIT 1
   FOR UPDATE;

  IF v_waiver_log_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is on waivers - submit a waiver claim instead.'
      USING ERRCODE = 'P0001';
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

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
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

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM weekly_lineups
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND game_date >= (now() AT TIME ZONE 'America/New_York')::date;

  INSERT INTO roster_players (
    member_id,
    league_id,
    league_season_id,
    player_id,
    acquired_via
  )
  VALUES (
    p_member_id,
    p_league_id,
    v_season_id,
    p_player_id,
    'free_agent'
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
END;
$$;

REVOKE ALL ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) TO service_role;
