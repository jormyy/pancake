CREATE OR REPLACE FUNCTION public.create_waiver_claim_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_priority int;
  v_waiver_log waiver_wire_log%ROWTYPE;
  v_claim_id uuid;
  v_lock_player_id uuid;
  v_drop_roster_id uuid;
BEGIN
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied'
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

  PERFORM pg_advisory_xact_lock(
    hashtext(p_league_id::text),
    hashtext(v_season_id::text)
  );

  SELECT priority
    INTO v_priority
    FROM waiver_priorities
   WHERE member_id = p_member_id
     AND league_season_id = v_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No waiver priority found for your team.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_league_id::text),
    hashtext(p_member_id::text)
  );

  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(
        ARRAY[p_player_id, p_drop_player_id]::uuid[]
      ) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(p_league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

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
    RAISE EXCEPTION 'Waiver claims require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_season_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_waiver_log
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
     AND clears_at > now()
   ORDER BY clears_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on waivers.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT rp.id
      INTO v_drop_roster_id
      FROM roster_players AS rp
     WHERE rp.member_id = p_member_id
       AND rp.league_id = p_league_id
       AND rp.league_season_id = v_season_id
       AND rp.player_id = p_drop_player_id
       AND rp.is_on_ir = false
       AND rp.is_on_taxi = false
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Drop player must be on your active roster.'
        USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM trade_drop_reservations AS reservation
        JOIN trades AS trade
          ON trade.id = reservation.trade_id
         AND trade.status = 'accepted'::trade_status
       WHERE reservation.roster_player_id = v_drop_roster_id
    ) OR EXISTS (
      SELECT 1
        FROM trade_items AS item
        JOIN trades AS trade
          ON trade.id = item.trade_id
         AND trade.status = 'accepted'::trade_status
       WHERE item.player_id = p_drop_player_id
         AND trade.league_id = p_league_id
         AND trade.league_season_id = v_season_id
         AND (
           (item.side = 'proposer' AND trade.proposer_member_id = p_member_id)
           OR (item.side = 'recipient' AND trade.recipient_member_id = p_member_id)
         )
    ) THEN
      RAISE EXCEPTION 'Drop player is reserved for an accepted trade.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_season_id
       AND player_id = p_player_id
       AND status = 'pending'
     FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'You already have a pending claim for this player.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO waiver_claims (
    league_id,
    league_season_id,
    member_id,
    player_id,
    drop_player_id,
    priority_at_submission,
    process_date
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    p_drop_player_id,
    v_priority,
    (v_waiver_log.clears_at AT TIME ZONE 'America/New_York')::date
  )
  RETURNING id INTO v_claim_id;

  RETURN v_claim_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_waiver_claim_atomic(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_waiver_claim_atomic(uuid, uuid, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_waiver_claim_atomic(uuid, uuid, uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_waiver_claim_atomic(uuid, uuid, uuid, uuid, uuid) TO service_role;
