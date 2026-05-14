-- Fix ambiguous PL/pgSQL references in process_next_waiver_claim_atomic.
--
-- The function returns columns named member_id, player_id, status, and
-- failure_reason. Unqualified table columns with the same names can resolve
-- ambiguously at runtime, which surfaced in the D.X.1 waiver push soak path.

DO $migration$
BEGIN
  EXECUTE $process_waiver_sql$
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
    FROM waiver_claims AS wc
    JOIN waiver_priorities AS wp
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

  PERFORM 1
    FROM waiver_priorities AS wp_lock
   WHERE wp_lock.league_id = v_claim.league_id
     AND wp_lock.league_season_id = v_claim.league_season_id
   ORDER BY wp_lock.priority
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM waiver_claims AS wc
      JOIN waiver_priorities AS wp
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
      FROM waiver_claims AS wc
      JOIN waiver_priorities AS wp
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
    FROM waiver_wire_log AS wwl
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
    UPDATE waiver_claims AS wc_update
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = v_failure
     WHERE wc_update.id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_priority'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM roster_players AS rp
     WHERE rp.league_id = v_claim.league_id
       AND rp.league_season_id = v_claim.league_season_id
       AND rp.player_id = v_claim.player_id
     FOR UPDATE
  ) THEN
    v_failure := 'Player already on a roster.';
    UPDATE waiver_claims AS wc_update
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = v_failure
     WHERE wc_update.id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_priority'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  SELECT l.roster_size
    INTO v_roster_size
    FROM leagues AS l
   WHERE l.id = v_claim.league_id;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players AS rp
   WHERE rp.league_id = v_claim.league_id
     AND rp.league_season_id = v_claim.league_season_id
     AND rp.member_id = v_claim.member_id
     AND rp.is_on_ir = false
     AND rp.is_on_taxi = false;

  IF v_active_count >= COALESCE(v_roster_size, 20) THEN
    IF v_claim.drop_player_id IS NULL THEN
      v_failure := 'Roster full and no drop player specified.';
      UPDATE waiver_claims AS wc_update
         SET status = 'failed_roster',
             processed_at = now(),
             failure_reason = v_failure
       WHERE wc_update.id = v_claim.id;

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
      RETURN;
    END IF;
  END IF;

  IF v_claim.drop_player_id IS NOT NULL THEN
    SELECT rp.id
      INTO v_drop_roster_id
      FROM roster_players AS rp
     WHERE rp.league_id = v_claim.league_id
       AND rp.league_season_id = v_claim.league_season_id
       AND rp.member_id = v_claim.member_id
       AND rp.player_id = v_claim.drop_player_id
     FOR UPDATE;

    IF NOT FOUND THEN
      v_failure := 'Drop player is no longer on this roster.';
      UPDATE waiver_claims AS wc_update
         SET status = 'failed_roster',
             processed_at = now(),
             failure_reason = v_failure
       WHERE wc_update.id = v_claim.id;

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
      RETURN;
    END IF;

    DELETE FROM roster_players AS rp
     WHERE rp.id = v_drop_roster_id;

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

  UPDATE waiver_wire_log AS wwl_update
     SET cleared_at = now(),
         claimed_by_claim_id = v_claim.id
   WHERE wwl_update.id = v_waiver_log_id;

  SELECT max(wp.priority)
    INTO v_max_priority
    FROM waiver_priorities AS wp
   WHERE wp.league_id = v_claim.league_id
     AND wp.league_season_id = v_claim.league_season_id;

  UPDATE waiver_priorities AS wp_update
     SET priority = COALESCE(v_max_priority, 0) + 1
   WHERE wp_update.league_id = v_claim.league_id
     AND wp_update.league_season_id = v_claim.league_season_id
     AND wp_update.member_id = v_claim.member_id;

  UPDATE waiver_claims AS wc_update
     SET status = 'succeeded',
         processed_at = now(),
         failure_reason = NULL
   WHERE wc_update.id = v_claim.id;

  UPDATE waiver_claims AS wc_other
     SET status = 'failed_priority',
         processed_at = now(),
         failure_reason = 'Claimed by higher-priority team.'
   WHERE wc_other.status = 'pending'
     AND wc_other.league_id = v_claim.league_id
     AND wc_other.league_season_id = v_claim.league_season_id
     AND wc_other.player_id = v_claim.player_id
     AND wc_other.id <> v_claim.id;

  RETURN QUERY
    SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;
END;
$$;
$process_waiver_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.process_next_waiver_claim_atomic(date) TO service_role';
END
$migration$;
