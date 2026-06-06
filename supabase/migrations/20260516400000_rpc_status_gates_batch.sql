-- ──────────────────────────────────────────────────────────────────────────
-- Batch: gate eight atomic roster/lineup/trade/waiver RPCs on leagues.status.
-- ──────────────────────────────────────────────────────────────────────────
-- Problem (SLICE A, iter 38):
--   Eight SECURITY DEFINER RPCs that mutate rosters, lineups, trades, and
--   waivers never validated leagues.status. A league_member or service-role
--   caller could therefore mutate season state during 'setup' (entirely
--   bypassing the draft for paths that should require an in-flight season),
--   or after 'offseason' / 'archived' (mutating a wound-down season).
--   add_free_agent_atomic was already gated in 20260516370000; this batch
--   closes the gap for every remaining roster-mutating RPC.
--
-- Gates (matched to each RPC's allowed lifecycle window):
--   drop_player_atomic                       → ('drafting','active','playoffs')
--     'drafting' allowed so rookie-draft / over-cap teams can trim during
--     a draft; the draft engine itself only writes via draft RPCs, so a
--     manager-initiated drop during 'drafting' is the only legitimate use.
--   accept_trade_atomic                      → ('active','playoffs')
--   complete_accepted_trade_atomic           → ('active','playoffs')
--   process_next_waiver_claim_atomic         → ('active','playoffs')
--   toggle_ir_atomic                         → ('drafting','active','playoffs')
--   toggle_taxi_atomic                       → ('drafting','active','playoffs')
--   set_player_slot_atomic                   → ('active','playoffs')
--   auto_set_lineup_atomic                   → ('active','playoffs')
--
-- Strategy:
--   For each RPC, CREATE OR REPLACE preserves the prior body byte-for-byte
--   (latest definitions: 20260516200000 for drop/accept/complete/waiver;
--   20260516230000 for toggle_ir/taxi; 20260516240000 for set_slot/auto_set).
--   The only change is:
--     1. Add a SELECT … FOR UPDATE on the leagues row (or fold the existing
--        leagues fetch into a full v_league row).
--     2. Immediately after the lock, raise a user-facing P0001 error unless
--        v_league.status is in the allowed list for that RPC.
--   The leagues row FOR UPDATE doubles as a serialization fence: any
--   concurrent advance_season_status / lifecycle transition holds the same
--   row and will block until this RPC commits or vice versa, so the
--   read-status-then-mutate window is atomic.
--
--   For RPCs that already locked leagues for a partial column (toggle_ir,
--   toggle_taxi, process_next_waiver_claim_atomic), the existing lookup is
--   widened to `SELECT * INTO v_league` so status is available without an
--   extra round-trip. All downstream reads (`v_league.roster_size`,
--   `v_league.ir_slots`, `v_league.taxi_slots`) use the same row.
--
-- Grants: every REVOKE/GRANT pattern from the source migrations is re-issued
-- here so this migration is self-contained and idempotent.

DO $migration$
BEGIN
  -- ────────────────────────────────────────────────────────────────────────
  -- drop_player_atomic — gate on ('drafting','active','playoffs')
  -- Body verbatim from 20260516200000 (serialize_roster_mutations). Adds a
  -- `SELECT * INTO v_league … FOR UPDATE` after the advisory lock and a
  -- status check.
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
  v_league leagues%ROWTYPE;
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

  -- Now that we know the (league_id, player_id), take the advisory lock
  -- that serializes this mutation against add_free_agent_atomic, trade
  -- completion, and waiver-claim processing on the same tuple.
  PERFORM pg_advisory_xact_lock(
    hashtext(v_rp.league_id::text),
    hashtext(v_rp.player_id::text)
  );

  -- Lock the leagues row and gate on status. 'drafting' is permitted so a
  -- manager can trim an over-cap roster during the draft (e.g. rookie-draft
  -- overflow). 'setup' / 'offseason' / 'archived' would mutate state outside
  -- any active season window.
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
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
  -- accept_trade_atomic — gate on ('active','playoffs')
  -- Body verbatim from 20260516200000 (serialize_roster_mutations). Adds a
  -- `SELECT * INTO v_league … FOR UPDATE` after the per-player advisory
  -- locks and a status check before the asset validation loop.
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
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_lock_player_id uuid;
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

  -- Take advisory locks on every distinct (league_id, player_id) tuple
  -- touched by this trade, ordered by player_id ASC so concurrent
  -- multi-player RPCs lock in identical order.
  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  -- Lock the leagues row and gate on status. Trades only make sense once a
  -- season is in-flight: 'setup' / 'drafting' would interfere with the
  -- draft engine; 'offseason' / 'archived' would mutate a wound-down season.
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate and lock every asset before opening the veto window. Assets do
  -- not move until complete_accepted_trade_atomic runs after the veto window.
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

  UPDATE trades
     SET status = 'accepted',
         accepted_at = now(),
         veto_window_expires_at = now() + INTERVAL '24 hours',
         completed_at = NULL,
         vetoed_at = NULL
   WHERE id = p_trade_id
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to accept trade atomically';
  END IF;
END;
$$;
$accept_trade_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- complete_accepted_trade_atomic — gate on ('active','playoffs')
  -- Body verbatim from 20260516200000 (serialize_roster_mutations). Adds a
  -- `SELECT * INTO v_league … FOR UPDATE` after the per-player advisory
  -- locks and a status check before the asset validation loop. The trade
  -- completion cron runs as service_role; gating here means a cron tick
  -- that fires after the league moved to 'offseason' / 'archived' will
  -- raise instead of moving assets.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $complete_trade_sql$
CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_lock_player_id uuid;
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

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'This trade is not accepted';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'The veto window is still open';
  END IF;

  -- Take advisory locks on every distinct (league_id, player_id) tuple
  -- touched by this trade, ordered by player_id ASC for deterministic
  -- ordering against other multi-player RPCs.
  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  -- Lock the leagues row and gate on status. Same envelope as
  -- accept_trade_atomic: a trade may only complete while the league is
  -- in 'active' or 'playoffs'.
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validate and lock every asset again at completion time. Any ownership
  -- drift during the veto window aborts the entire completion.
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
  -- both legs may have lineup rows pointing at the same player_id, so wipe
  -- across the whole league. This was previously placed in
  -- accept_trade_atomic by migration 20260516173100, but assets do not move
  -- until this completion step, so the cleanup lives here.
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
         completed_at = now()
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;
END;
$$;
$complete_trade_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.complete_accepted_trade_atomic(uuid) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- process_next_waiver_claim_atomic — gate on ('active','playoffs')
  -- Body verbatim from 20260516200000 (serialize_roster_mutations). The
  -- existing partial `SELECT l.roster_size FROM leagues l WHERE l.id = …`
  -- is widened to a full v_league fetch with FOR UPDATE; the status gate
  -- runs immediately after.
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
  v_league leagues%ROWTYPE;
  v_waiver_log_id uuid;
  v_roster_size int;
  v_active_count int;
  v_drop_roster_id uuid;
  v_max_priority int;
  v_failure text;
  v_lock_player_id uuid;
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

  -- Now that the winning claim is locked, take advisory locks on every
  -- (league_id, player_id) we are about to mutate. Order by player_id ASC
  -- against the canonical ordering used by accept_trade_atomic and
  -- complete_accepted_trade_atomic so concurrent RPCs touching the same
  -- player(s) acquire locks in the same order.
  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(
        ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]
      ) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_claim.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

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

  -- Lock the leagues row and gate on status. Widens the prior partial
  -- `SELECT l.roster_size` into the full v_league row so status is
  -- available without an extra round-trip. Waivers only process while the
  -- season is in-flight ('active' / 'playoffs').
  SELECT *
    INTO v_league
    FROM leagues AS l
   WHERE l.id = v_claim.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Waivers require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := v_league.roster_size;

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
       AND rp.is_on_ir = false
       AND rp.is_on_taxi = false
     FOR UPDATE;

    IF NOT FOUND THEN
      v_failure := 'Drop player is no longer on this active roster.';
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

  -- ────────────────────────────────────────────────────────────────────────
  -- toggle_ir_atomic — gate on ('drafting','active','playoffs')
  -- Body verbatim from 20260516230000 (atomic_ir_taxi_toggle). The existing
  -- partial `SELECT roster_size, ir_slots FROM leagues … FOR UPDATE` is
  -- widened to a full v_league fetch; the status gate runs immediately after.
  -- 'drafting' is permitted so a manager who drafted an injured player can
  -- shelf them to IR before the season opens.
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
  v_league leagues%ROWTYPE;
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

  -- Fetch league row and lock so caps and status cannot change mid-transaction.
  -- Widened from the prior partial fetch so status is available here.
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'IR moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

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
  -- toggle_taxi_atomic — gate on ('drafting','active','playoffs')
  -- Body verbatim from 20260516230000 (atomic_ir_taxi_toggle). Widens the
  -- prior partial `SELECT roster_size, taxi_slots FROM leagues … FOR UPDATE`
  -- to a full v_league fetch; status gate runs immediately after. 'drafting'
  -- is permitted so a manager can immediately stash a drafted rookie on the
  -- taxi squad.
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
  v_league leagues%ROWTYPE;
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

  -- Fetch the league row and lock so caps and status cannot change mid-tx.
  -- Widened from the prior partial fetch so status is available here.
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Taxi moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_taxi_slots := COALESCE(v_league.taxi_slots, 0);

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

  -- ────────────────────────────────────────────────────────────────────────
  -- set_player_slot_atomic — gate on ('active','playoffs')
  -- Body verbatim from 20260516240000 (atomic_lineup_set). Adds a
  -- `SELECT * INTO v_league … FOR UPDATE` after the caller-ownership check
  -- and a status check. Lineup writes outside an active season are pure
  -- noise: there are no games to be scored.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $set_slot_sql$
CREATE OR REPLACE FUNCTION public.set_player_slot_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_game_date date,
  p_slot_type roster_slot_type,
  p_week_number int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_roster_id uuid;
BEGIN
  -- Serialize every lineup mutation on (member_id, game_date). Two devices
  -- firing setPlayerSlot / autoSet for the same day will queue.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  -- Re-verify caller ownership. Mirrors the weekly_lineups RLS policies
  -- we bypass via SECURITY DEFINER.
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the leagues row and gate on status. Lineups are only meaningful
  -- once the season is in-flight ('active' / 'playoffs').
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
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Re-verify the member currently owns this player. FOR SHARE blocks
  -- against a concurrent drop_player_atomic / accept_trade_atomic /
  -- process_next_waiver_claim_atomic SELECT FOR UPDATE on the same row,
  -- so the check cannot be stale at commit time.
  SELECT id
    INTO v_roster_id
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND player_id = p_player_id
   FOR SHARE;

  IF v_roster_id IS NULL THEN
    RAISE EXCEPTION 'Player is no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_slot_type = 'BE'::roster_slot_type THEN
    -- Bench is implicit: no row means bench. Match the prior client
    -- behavior of DELETE-on-bench.
    DELETE FROM weekly_lineups
     WHERE member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND player_id = p_player_id
       AND game_date = p_game_date;
  ELSE
    INSERT INTO weekly_lineups (
      member_id,
      league_id,
      league_season_id,
      player_id,
      week_number,
      game_date,
      slot_type,
      is_auto_set,
      set_at
    )
    VALUES (
      p_member_id,
      p_league_id,
      p_league_season_id,
      p_player_id,
      p_week_number,
      p_game_date,
      p_slot_type,
      false,
      now()
    )
    ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
    DO UPDATE SET
      slot_type = EXCLUDED.slot_type,
      week_number = EXCLUDED.week_number,
      is_auto_set = EXCLUDED.is_auto_set,
      set_at = EXCLUDED.set_at;
  END IF;
END;
$$;
$set_slot_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- auto_set_lineup_atomic — gate on ('active','playoffs')
  -- Body verbatim from 20260516240000 (atomic_lineup_set). Adds a
  -- `SELECT * INTO v_league … FOR UPDATE` after the caller-ownership check
  -- and a status check before any lineup mutation.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $auto_set_sql$
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
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_player_ids uuid[];
  v_owned_count int;
  v_total_count int;
BEGIN
  -- Serialize every lineup mutation on (member_id, game_date). Two
  -- concurrent autoSets for the same day will queue.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  -- Re-verify caller ownership of the league_member.
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the leagues row and gate on status. Lineups are only meaningful
  -- once the season is in-flight ('active' / 'playoffs').
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
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Reject malformed input.
  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  -- Extract the distinct player_ids referenced in assignments, sorted ASC
  -- to deadlock-proof the FOR SHARE acquisition order against concurrent
  -- auto-sets for the same member.
  SELECT array_agg(DISTINCT (a->>'player_id')::uuid ORDER BY (a->>'player_id')::uuid)
    INTO v_player_ids
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL;

  v_player_ids := COALESCE(v_player_ids, ARRAY[]::uuid[]);

  -- Re-verify every player_id is currently in the caller's roster for
  -- this season. FOR SHARE prevents stale ownership against concurrent
  -- drops / trades / waiver claims.
  IF array_length(v_player_ids, 1) IS NOT NULL THEN
    PERFORM 1
       FROM roster_players
      WHERE member_id = p_member_id
        AND league_id = p_league_id
        AND league_season_id = p_league_season_id
        AND player_id = ANY (v_player_ids)
      FOR SHARE;

    SELECT count(*)
      INTO v_owned_count
      FROM roster_players
     WHERE member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND player_id = ANY (v_player_ids);

    v_total_count := array_length(v_player_ids, 1);
    IF v_owned_count <> v_total_count THEN
      RAISE EXCEPTION 'One or more players in the lineup are no longer on your roster.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Replace the day's lineup. Single transaction → either the full
  -- replacement lands or nothing changes.
  DELETE FROM weekly_lineups
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND game_date = p_game_date;

  -- Insert all non-bench rows. BE is implicit (no row means bench).
  INSERT INTO weekly_lineups (
    member_id,
    league_id,
    league_season_id,
    player_id,
    week_number,
    game_date,
    slot_type,
    is_auto_set,
    set_at
  )
  SELECT
    p_member_id,
    p_league_id,
    p_league_season_id,
    (a->>'player_id')::uuid,
    COALESCE((a->>'week_number')::int, 1),
    p_game_date,
    (a->>'slot_type')::roster_slot_type,
    COALESCE((a->>'is_auto_set')::boolean, true),
    now()
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL
     AND a->>'slot_type' IS NOT NULL
     AND (a->>'slot_type')::roster_slot_type <> 'BE'::roster_slot_type;
END;
$$;
$auto_set_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) TO service_role';
END
$migration$;
