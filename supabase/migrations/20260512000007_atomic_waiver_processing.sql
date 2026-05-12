-- Process waiver claims through one locked database function shared by the
-- backend worker and Supabase Edge function.
--
-- Finding:
-- - P1-22: backend and Edge waiver processors had divergent roster-count logic
--   and processed claims in stale priority_at_submission order, so multiple
--   claims in one run could ignore priority changes made by earlier wins.

CREATE OR REPLACE FUNCTION public.process_next_waiver_claim_atomic(
  p_process_date date
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_waiver_log_id uuid;
  v_roster_size int;
  v_active_count int;
  v_drop_roster_id uuid;
  v_max_priority int;
  v_failure text;
BEGIN
  SELECT wc.*
    INTO v_claim
    FROM waiver_claims wc
    JOIN waiver_priorities wp
      ON wp.league_id = wc.league_id
     AND wp.league_season_id = wc.league_season_id
     AND wp.member_id = wc.member_id
   WHERE wc.status = 'pending'
     AND wc.process_date <= p_process_date
   ORDER BY wc.league_id, wc.league_season_id, wp.priority, wc.submitted_at, wc.id
   LIMIT 1
   FOR UPDATE OF wc SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, NULL::waiver_claim_status, NULL::text;
    RETURN;
  END IF;

  -- Serialize every claim processor for this league-season. This prevents two
  -- workers from evaluating priority order or roster space from stale state.
  PERFORM 1
    FROM waiver_priorities
   WHERE league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id
   ORDER BY priority
   FOR UPDATE;

  -- If another concurrent worker changed priorities while this transaction was
  -- waiting, make the caller retry so the next claim is chosen from fresh order.
  IF EXISTS (
    SELECT 1
      FROM waiver_claims wc
      JOIN waiver_priorities wp
        ON wp.league_id = wc.league_id
       AND wp.league_season_id = wc.league_season_id
       AND wp.member_id = wc.member_id
     WHERE wc.status = 'pending'
       AND wc.process_date <= p_process_date
       AND wc.league_id = v_claim.league_id
       AND wc.league_season_id = v_claim.league_season_id
       AND wc.id <> v_claim.id
     ORDER BY wp.priority, wc.submitted_at, wc.id
     LIMIT 1
  ) THEN
    SELECT wc.*
      INTO v_claim
      FROM waiver_claims wc
      JOIN waiver_priorities wp
        ON wp.league_id = wc.league_id
       AND wp.league_season_id = wc.league_season_id
       AND wp.member_id = wc.member_id
     WHERE wc.status = 'pending'
       AND wc.process_date <= p_process_date
       AND wc.league_id = v_claim.league_id
       AND wc.league_season_id = v_claim.league_season_id
     ORDER BY wp.priority, wc.submitted_at, wc.id
     LIMIT 1
     FOR UPDATE OF wc;
  END IF;

  SELECT wwl.id
    INTO v_waiver_log_id
    FROM waiver_wire_log wwl
   WHERE wwl.league_id = v_claim.league_id
     AND wwl.league_season_id = v_claim.league_season_id
     AND wwl.player_id = v_claim.player_id
     AND wwl.cleared_at IS NULL
     AND wwl.clears_at > now()
   ORDER BY wwl.clears_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    v_failure := 'Player no longer on waivers.';
    UPDATE waiver_claims
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = v_failure
     WHERE id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_priority'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_claim.league_id
       AND league_season_id = v_claim.league_season_id
       AND player_id = v_claim.player_id
     FOR UPDATE
  ) THEN
    v_failure := 'Player already on a roster.';
    UPDATE waiver_claims
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = v_failure
     WHERE id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_priority'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  SELECT roster_size
    INTO v_roster_size
    FROM leagues
   WHERE id = v_claim.league_id;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id
     AND member_id = v_claim.member_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF v_active_count >= COALESCE(v_roster_size, 20) THEN
    IF v_claim.drop_player_id IS NULL THEN
      v_failure := 'Roster full and no drop player specified.';
      UPDATE waiver_claims
         SET status = 'failed_roster',
             processed_at = now(),
             failure_reason = v_failure
       WHERE id = v_claim.id;

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
      RETURN;
    END IF;
  END IF;

  IF v_claim.drop_player_id IS NOT NULL THEN
    SELECT id
      INTO v_drop_roster_id
      FROM roster_players
     WHERE league_id = v_claim.league_id
       AND league_season_id = v_claim.league_season_id
       AND member_id = v_claim.member_id
       AND player_id = v_claim.drop_player_id
     FOR UPDATE;

    IF NOT FOUND THEN
      v_failure := 'Drop player is no longer on this roster.';
      UPDATE waiver_claims
         SET status = 'failed_roster',
             processed_at = now(),
             failure_reason = v_failure
       WHERE id = v_claim.id;

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
      RETURN;
    END IF;

    DELETE FROM roster_players WHERE id = v_drop_roster_id;

    INSERT INTO waiver_wire_log (
      league_id,
      league_season_id,
      player_id,
      dropped_by_member_id,
      clears_at
    )
    VALUES (
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.drop_player_id,
      v_claim.member_id,
      now() + interval '48 hours'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      related_claim_id
    )
    VALUES (
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.drop_player_id,
      'waiver_drop',
      v_claim.id
    );
  END IF;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    acquired_via
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver_add',
    v_claim.id
  );

  UPDATE waiver_wire_log
     SET cleared_at = now(),
         claimed_by_claim_id = v_claim.id
   WHERE id = v_waiver_log_id;

  SELECT max(priority)
    INTO v_max_priority
    FROM waiver_priorities
   WHERE league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id;

  UPDATE waiver_priorities
     SET priority = COALESCE(v_max_priority, 0) + 1
   WHERE league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id
     AND member_id = v_claim.member_id;

  UPDATE waiver_claims
     SET status = 'succeeded',
         processed_at = now(),
         failure_reason = NULL
   WHERE id = v_claim.id;

  UPDATE waiver_claims
     SET status = 'failed_priority',
         processed_at = now(),
         failure_reason = 'Claimed by higher-priority team.'
   WHERE status = 'pending'
     AND league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id
     AND player_id = v_claim.player_id
     AND id <> v_claim.id;

  RETURN QUERY
    SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM anon;
REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_next_waiver_claim_atomic(date) TO service_role;
