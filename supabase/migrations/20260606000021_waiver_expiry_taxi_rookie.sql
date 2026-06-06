CREATE OR REPLACE FUNCTION public.expire_waiver_wire_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
BEGIN
  UPDATE waiver_wire_log AS wwl
     SET cleared_at = now()
    FROM league_seasons AS season,
         leagues AS league
   WHERE wwl.cleared_at IS NULL
     AND season.id = wwl.league_season_id
     AND season.is_current = true
     AND league.id = wwl.league_id
     AND league.status IN ('active'::league_status, 'playoffs'::league_status)
     AND wwl.clears_at < now()
     AND NOT EXISTS (
       SELECT 1
         FROM waiver_claims AS wc
        WHERE wc.league_id = wwl.league_id
          AND wc.league_season_id = wwl.league_season_id
          AND wc.player_id = wwl.player_id
          AND wc.status = 'pending'
     );

  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN v_expired;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_waiver_wire_logs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_waiver_wire_logs() FROM anon;
REVOKE ALL ON FUNCTION public.expire_waiver_wire_logs() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_waiver_wire_logs() TO service_role;

CREATE OR REPLACE FUNCTION public.toggle_taxi_atomic(
  p_roster_player_id uuid,
  p_to_taxi boolean,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_draft_number int;
  v_years_exp int;
  v_roster_size int;
  v_taxi_slots int;
  v_other_taxi_count int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_rp.league_id::text),
    hashtext(v_rp.player_id::text)
  );

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  SELECT roster_size, taxi_slots
    INTO v_roster_size, v_taxi_slots
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  v_roster_size := COALESCE(v_roster_size, 20);
  v_taxi_slots := COALESCE(v_taxi_slots, 0);

  IF p_to_taxi THEN
    IF v_rp.is_on_ir THEN
      RAISE EXCEPTION 'Activate the player from IR before moving them to taxi.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT p.nba_draft_number, p.years_exp
      INTO v_draft_number, v_years_exp
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF v_draft_number IS NULL OR v_years_exp IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Only current rookies can be placed on the taxi squad.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_taxi_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_taxi = true
       AND id <> p_roster_player_id;

    IF v_other_taxi_count >= v_taxi_slots THEN
      RAISE EXCEPTION 'You only have % taxi squad slot%.', v_taxi_slots, CASE WHEN v_taxi_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_taxi = p_to_taxi
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle taxi status'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_to_taxi THEN
    DELETE FROM weekly_lineups
     WHERE member_id = v_rp.member_id
       AND league_id = v_rp.league_id
       AND league_season_id = v_rp.league_season_id
       AND player_id = v_rp.player_id;
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_taxi THEN 'taxi_designate' ELSE 'taxi_return' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) TO service_role;
