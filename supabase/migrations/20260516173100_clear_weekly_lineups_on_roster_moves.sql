-- Clear stale weekly_lineups rows whenever a player changes ownership.
--
-- Finding (iter 16, slice A):
-- - weekly_lineups has a unique constraint on
--   (league_id, league_season_id, member_id, player_id, game_date), so the
--   OLD owner's row and a NEW owner's row for the same player on the same
--   day can coexist after a drop/trade/waiver swap.
-- - syncScores' calcWeekPointsByMember reads weekly_lineups by member_id
--   without joining roster_players, so the daily scorer can double-count or
--   credit points to the wrong member after a roster move.
--
-- The IR/Taxi path in backend/src/services/roster.ts already calls
-- clearLineupsForRosterPlayer to delete weekly_lineups when a player's
-- status changes. The three atomic RPCs that mutate roster ownership
-- (drop_player_atomic, accept_trade_atomic, process_next_waiver_claim_atomic)
-- need the same cleanup so the scorer cannot see stale rows.
--
-- Strategy: CREATE OR REPLACE each function with byte-identical body PLUS
-- DELETE FROM weekly_lineups WHERE league_id = <id> AND player_id = <pid>
-- for every player whose ownership changed in the transaction. Clearing all
-- rows for a (league_id, player_id) pair is safe because the new owner will
-- (re)create a fresh row when they set their lineup; transient lineup
-- entries for a player who just changed teams must be considered stale.

DO $migration$
BEGIN
  -- ────────────────────────────────────────────────────────────────────────
  -- drop_player_atomic
  -- Single player drop; clear that player's weekly_lineups rows.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $drop_player_sql$
CREATE OR REPLACE FUNCTION public.drop_player_atomic(
  p_roster_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_clears_at timestamptz := now() + interval '48 hours';
  v_rows int;
BEGIN
  -- Lock the roster row first so concurrent drops/trades can't race.
  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player — you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Confirm the caller actually owns this league_member. This mirrors the
  -- "roster_players_delete_own" RLS policy that we bypass via SECURITY DEFINER.
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player — you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player — you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Clear any weekly_lineups rows for this player in this league so the
  -- daily scorer can't credit the now-departed owner. Scoped by league_id
  -- so member-level cleanup is unnecessary: the player is gone from the
  -- league until they re-enter via waiver or trade.
  DELETE FROM weekly_lineups
   WHERE league_id = v_rp.league_id
     AND player_id = v_rp.player_id;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id,
    v_clears_at
  );

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
    'fa_drop'
  );
END;
$$;
$drop_player_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.drop_player_atomic(uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.drop_player_atomic(uuid) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.drop_player_atomic(uuid) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.drop_player_atomic(uuid) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- accept_trade_atomic
  -- Multiple players may swap. Clear weekly_lineups for every player_id
  -- across all trade_items in one set-based DELETE before applying moves.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $accept_trade_sql$
CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_rows int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'pending' THEN
    RAISE EXCEPTION 'This trade is no longer pending';
  END IF;

  IF v_trade.recipient_member_id <> p_accepting_member_id THEN
    RAISE EXCEPTION 'Only the recipient can accept this trade';
  END IF;

  -- Validate and lock every asset before applying any mutation.
  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected trade side';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;
    END IF;
  END LOOP;

  -- Clear weekly_lineups for every player on either side of the trade so
  -- post-trade scoring won't credit the prior owner. Scoped by league_id;
  -- both legs may have lineup rows pointing at the same player_id (e.g. one
  -- side rostered them this morning), so wipe across the whole league.
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = v_trade.league_id
     AND wl.player_id IN (
       SELECT ti.player_id
         FROM trade_items AS ti
        WHERE ti.trade_id = p_trade_id
          AND ti.player_id IS NOT NULL
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;
    v_to_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade'
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically';
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', p_trade_id);
    ELSE
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically';
      END IF;
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         accepted_at = now(),
         completed_at = now()
   WHERE id = p_trade_id
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;
END;
$$;
$accept_trade_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- process_next_waiver_claim_atomic
  -- A claim adds one player (v_claim.player_id) and may drop another
  -- (v_claim.drop_player_id). Clear weekly_lineups for both player_ids in
  -- the league, immediately after the drop-step decision is finalized
  -- and just before the new INSERT into roster_players runs.
  -- Note: this is a CREATE OR REPLACE of the most recent on-main version
  -- (20260512000010_fix_waiver_atomic_ambiguity.sql) with the alias-qualified
  -- column refs preserved byte-for-byte and a DELETE block added.
  -- ────────────────────────────────────────────────────────────────────────
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

    -- Clear weekly_lineups for the dropped player so the scorer cannot
    -- continue to credit the dropping member after the row is gone.
    DELETE FROM weekly_lineups AS wl
     WHERE wl.league_id = v_claim.league_id
       AND wl.player_id = v_claim.drop_player_id;

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

  -- Clear any weekly_lineups rows for the incoming player. He was on
  -- waivers, but a prior owner (whose roster row was already removed when
  -- they dropped him) may have left lineup rows behind that pre-date this
  -- migration. Defensive: keep the scorer from ever seeing two members
  -- credited for the same incoming player on the same day.
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = v_claim.league_id
     AND wl.player_id = v_claim.player_id;

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
