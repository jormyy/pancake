-- Atomic IR / taxi designate-and-return RPCs.
--
-- Finding (iter 23, slice A):
-- - backend/src/services/roster.ts toggleIRStatus / toggleTaxiStatus do
--   SELECT-then-UPDATE outside any lock. The IR-cap check (`count < irSlots`),
--   taxi-cap check (`count < taxiSlots`), and active-roster check
--   (`activeCount < roster_size`) all read the count, then issue a separate
--   UPDATE roster_players. Two concurrent designates from different devices
--   for the same member can both pass the cap check and then both UPDATE
--   distinct rows, pushing the IR or taxi count past the league cap. A
--   toggleIR(return) racing with add_free_agent_atomic can also push the
--   active count past roster_size.
-- - Migration 20260516200000 (serialize_roster_mutations) closed the same
--   class of race on add_free_agent_atomic / drop_player_atomic /
--   accept_trade_atomic / complete_accepted_trade_atomic /
--   process_next_waiver_claim_atomic via pg_advisory_xact_lock(league_id,
--   player_id), but the IR/taxi service path was missed because it did not
--   go through an atomic RPC at all.
--
-- Strategy: introduce two SECURITY DEFINER RPCs that mirror the existing
-- atomic-RPC pattern.
--   toggle_ir_atomic(p_roster_player_id, p_to_ir, p_user_id)
--   toggle_taxi_atomic(p_roster_player_id, p_to_taxi, p_user_id)
-- Each:
--   1. SELECT … FOR UPDATE the roster row by primary key (locks against
--      concurrent toggles / drops / trades on the same row).
--   2. PERFORM pg_advisory_xact_lock(hashtext(league_id), hashtext(player_id))
--      so any other roster-mutating RPC for the same (league, player) tuple
--      blocks until this transaction commits — same key shape as
--      20260516200000.
--   3. Verify the caller (passed in as p_user_id by the backend service,
--      which has already authenticated the user) actually owns the
--      league_member that owns the roster row.
--   4. Re-check IR / taxi / active-roster caps under the lock and against
--      the league's current roster_size / ir_slots / taxi_slots.
--   5. UPDATE roster_players in the same transaction, plus the existing
--      side effects: DELETE weekly_lineups when entering IR/taxi,
--      INSERT roster_transactions audit row.
--
-- The backend service is the only caller (service_role), so we only GRANT
-- EXECUTE to service_role — matching accept_trade_atomic /
-- complete_accepted_trade_atomic / process_next_waiver_claim_atomic. The
-- public API (POST /league/roster/ir, /taxi) is unchanged: the service
-- still performs request validation, then delegates to these RPCs instead
-- of issuing inline SELECT/UPDATE statements.
--
-- Deadlock safety:
-- - Each RPC acquires exactly one row lock + one advisory lock (always
--   single-player) — no order issue against itself.
-- - All other roster-mutating RPCs (post 20260516200000) acquire the
--   advisory lock keyed on (league_id, player_id). Single-player RPCs hold
--   exactly one lock, so they cannot deadlock against these toggles either.
--   Multi-player RPCs (accept_trade_atomic / complete_accepted_trade_atomic
--   / process_next_waiver_claim_atomic) acquire their advisory locks in
--   player_id ASC order; a toggle holds one lock, so the toggle either
--   gets in first (the multi-player RPC waits) or queues behind one of the
--   multi-player RPC's already-held locks (and the multi-player RPC
--   completes without ever waiting on the toggle). No cycle is possible.

DO $migration$
BEGIN
  -- ────────────────────────────────────────────────────────────────────────
  -- toggle_ir_atomic
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $toggle_ir_sql$
CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(
  p_roster_player_id uuid,
  p_to_ir boolean,
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
  v_injury text;
  v_roster_size int;
  v_ir_slots int;
  v_other_ir_count int;
  v_active_count int;
  v_rows int;
BEGIN
  -- Lock the target roster row first. Locks against concurrent toggles,
  -- drops, and trades for the same row.
  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Serialize every roster mutation on this (league_id, player_id) tuple.
  -- Same key shape as 20260516200000 so add_free_agent_atomic,
  -- drop_player_atomic, accept_trade_atomic, complete_accepted_trade_atomic,
  -- and process_next_waiver_claim_atomic all see the same lock.
  PERFORM pg_advisory_xact_lock(
    hashtext(v_rp.league_id::text),
    hashtext(v_rp.player_id::text)
  );

  -- Verify the caller owns this league_member. The backend has already
  -- authenticated the user; we re-check here so the RPC is safe under any
  -- caller. Mirrors the original toggleIRStatus pre-condition (line 42-45
  -- of backend/src/services/roster.ts before this migration).
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  -- Fetch league caps and lock so they cannot change mid-transaction.
  SELECT roster_size, ir_slots
    INTO v_roster_size, v_ir_slots
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  v_roster_size := COALESCE(v_roster_size, 20);
  v_ir_slots := COALESCE(v_ir_slots, 2);

  IF p_to_ir THEN
    -- IR-eligibility check: mirrors core/isIREligible — injury_status
    -- (lowercased) must equal 'out' or start with 'ir'.
    SELECT p.injury_status
      INTO v_injury
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF NOT (
      lower(COALESCE(v_injury, '')) = 'out'
      OR lower(COALESCE(v_injury, '')) LIKE 'ir%'
    ) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Count the caller's other IR slots under the lock.
    SELECT count(*)
      INTO v_other_ir_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = true
       AND id <> p_roster_player_id;

    IF v_other_ir_count >= v_ir_slots THEN
      RAISE EXCEPTION 'You only have % IR slot%.', v_ir_slots, CASE WHEN v_ir_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Returning from IR. Re-check active roster cap under the lock. Counts
    -- every active (non-IR, non-taxi) row INCLUDING this one if it is
    -- already active — but here the row is on IR, so it is excluded; the
    -- comparison `count >= roster_size` is the right post-toggle check.
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

  -- Apply the toggle. Preserve the existing rule: entering IR force-clears
  -- is_on_taxi so the chk_not_ir_and_taxi constraint cannot fire (the
  -- original service code did the same thing inline).
  UPDATE roster_players
     SET is_on_ir = p_to_ir,
         is_on_taxi = CASE WHEN p_to_ir THEN false ELSE is_on_taxi END
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle IR status'
      USING ERRCODE = 'P0001';
  END IF;

  -- Side effects. When entering IR, clear weekly_lineups for the (league,
  -- player) pair so the daily scorer cannot credit IR players. Matches the
  -- prior clearLineupsForRosterPlayer behavior in roster.ts.
  IF p_to_ir THEN
    DELETE FROM weekly_lineups
     WHERE member_id = v_rp.member_id
       AND league_id = v_rp.league_id
       AND league_season_id = v_rp.league_season_id
       AND player_id = v_rp.player_id;
  END IF;

  -- Audit row matches the prior logRosterPlacement call.
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
    CASE WHEN p_to_ir THEN 'ir_designate' ELSE 'ir_return' END
  );
END;
$$;
$toggle_ir_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.toggle_ir_atomic(uuid, boolean, uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.toggle_ir_atomic(uuid, boolean, uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.toggle_ir_atomic(uuid, boolean, uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.toggle_ir_atomic(uuid, boolean, uuid) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- toggle_taxi_atomic
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $toggle_taxi_sql$
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
  v_roster_size int;
  v_taxi_slots int;
  v_other_taxi_count int;
  v_active_count int;
  v_rows int;
BEGIN
  -- Lock the target roster row first.
  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Serialize on (league_id, player_id). Same key shape as 20260516200000.
  PERFORM pg_advisory_xact_lock(
    hashtext(v_rp.league_id::text),
    hashtext(v_rp.player_id::text)
  );

  -- Re-verify caller ownership under the lock.
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  -- Fetch league caps and lock.
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
    -- Cannot go directly from IR to taxi — the original service rejected
    -- this and the chk_not_ir_and_taxi DB constraint would reject it anyway.
    IF v_rp.is_on_ir THEN
      RAISE EXCEPTION 'Activate the player from IR before moving them to taxi.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Taxi-eligibility: rookie (nba_draft_number IS NOT NULL). Matches the
    -- local isTaxiEligible helper in roster.ts.
    SELECT p.nba_draft_number
      INTO v_draft_number
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF v_draft_number IS NULL THEN
      RAISE EXCEPTION 'Only rookies can be placed on the taxi squad.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Re-check taxi cap under the lock.
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
    -- Returning from taxi to active. Re-check active roster cap.
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

  -- Apply the toggle. The original service only mutated is_on_taxi, never
  -- is_on_ir, on this path; preserve that.
  UPDATE roster_players
     SET is_on_taxi = p_to_taxi
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle taxi status'
      USING ERRCODE = 'P0001';
  END IF;

  -- Side effects: clear weekly_lineups on entry to taxi, log transaction.
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
$toggle_taxi_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.toggle_taxi_atomic(uuid, boolean, uuid) TO service_role';
END
$migration$;
