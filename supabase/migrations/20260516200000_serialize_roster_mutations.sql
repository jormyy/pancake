-- Serialize every roster mutation on a given (league_id, player_id) tuple.
--
-- Finding (iter 21, slice A):
-- - add_free_agent_atomic (introduced in 20260516180000) races with
--   drop_player_atomic (20260516091500, weekly-lineups variant in
--   20260516173100). Race window:
--     T1 (add): SELECTs waiver_wire_log for player X → no row → continues.
--     T2 (drop): begins, deletes roster row for X, inserts the
--                waiver_wire_log row for X, commits.
--     T1: INSERTs roster_players for X (T2 already removed the old row,
--         so no unique-key violation) and commits.
--   Result: X is both on T1's roster AND has an open waiver_wire_log row
--   from T2's drop. Subsequent waiver claims for X will fail with
--   "Player already on a roster" while the waiver UI still shows X as
--   claimable.
-- - The reviewer's suggested fix (swap lock order, lock roster_players
--   first) does not help because there is no existing roster_players row
--   when X is a free agent — `FOR UPDATE` on zero rows locks nothing.
-- - accept_trade_atomic / complete_accepted_trade_atomic /
--   process_next_waiver_claim_atomic have the same shape of race: any
--   two of them, or one of them plus drop/add, can interleave their
--   SELECT FOR UPDATE windows on a non-existent roster row.
--
-- Strategy: PostgreSQL transaction-scoped advisory locks keyed by the
-- (league_id, player_id) tuple. pg_advisory_xact_lock(int4, int4) is
-- already used elsewhere in the schema (20260512000005), and the
-- two-argument variant gives 64 bits of key space when paired with
-- hashtext() of each uuid. Acquired at the very top of every RPC that
-- mutates roster_players for a player, the lock is held until the
-- transaction commits or rolls back, serializing every mutation on the
-- same (league, player) pair regardless of which RPC initiated it.
--
-- Deadlock safety:
-- - Single-player RPCs (add_free_agent_atomic, drop_player_atomic) hold
--   exactly one lock — no order issue.
-- - Multi-player RPCs (accept_trade_atomic,
--   complete_accepted_trade_atomic, process_next_waiver_claim_atomic)
--   acquire locks in a deterministic order: distinct player_ids ASC.
--   Two concurrent multi-player RPCs touching the same set of players
--   will therefore see the locks in the same order and cannot deadlock
--   against each other. Single-player RPCs hold only one lock so they
--   cannot deadlock against a multi-player RPC either.
--
-- This migration is a pure CREATE OR REPLACE wrapper around the current
-- bodies of each RPC. The only change is a `PERFORM pg_advisory_xact_lock(...)`
-- block at the top of each function body. Behavior, error messages,
-- return shapes, and grants are preserved byte-for-byte (verified
-- against 20260516180000 for add_free_agent_atomic, 20260516173100
-- for drop_player_atomic + process_next_waiver_claim_atomic, and
-- 20260516190000 for accept_trade_atomic + complete_accepted_trade_atomic).

DO $migration$
BEGIN
  -- ────────────────────────────────────────────────────────────────────────
  -- add_free_agent_atomic
  -- Single (league_id, player_id) — one lock at the top.
  -- ────────────────────────────────────────────────────────────────────────
  EXECUTE $add_free_agent_sql$
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
  v_season_id uuid;
  v_roster_size int;
  v_active_count int;
  v_waiver_log_id uuid;
  v_existing_roster_id uuid;
  v_ineligible text;
BEGIN
  -- Serialize every roster mutation on this (league_id, player_id) tuple
  -- for the lifetime of the transaction. Closes the free-agent / drop
  -- race documented at the top of this migration.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_league_id::text),
    hashtext(p_player_id::text)
  );

  -- Confirm the caller actually owns this league_member. Mirrors the RLS
  -- policies on roster_players we bypass via SECURITY DEFINER.
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player — you may not have permission for this league.'
      USING ERRCODE = '42501';
  END IF;

  -- Resolve the current season (fall back to the most recent, matching the
  -- prior client-side getCurrentSeasonId/getActiveSeasonId behavior).
  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    SELECT id
      INTO v_season_id
      FROM league_seasons
     WHERE league_id = p_league_id
     ORDER BY season_year DESC
     LIMIT 1;
  END IF;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;

  -- Block the add if the caller has an ineligible IR player on their roster.
  -- Mirrors core/isIREligible: a row is IR-eligible if its injury_status
  -- (lowercased) equals 'out' or starts with 'ir'. Anyone on IR who fails
  -- both tests is "ineligible" and must be activated/dropped first.
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

  -- Lock any active waiver_wire_log row for this player+league. If it exists
  -- and has not yet cleared, the player is on waivers and free-agent adds
  -- must be blocked — the only legitimate path is a waiver_claim.
  SELECT id
    INTO v_waiver_log_id
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
     AND clears_at > now()
   ORDER BY clears_at
   LIMIT 1
   FOR UPDATE;

  IF v_waiver_log_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is on waivers — submit a waiver claim instead.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock any existing roster_players row for this player in this season. If
  -- one exists, another team owns the player and the add must fail. Locking
  -- across all members in the season closes the scoop race against a
  -- concurrent drop_player_atomic (which deletes its own row before this
  -- transaction can see the gap).
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

  -- Fetch the league's roster size cap and lock it so the cap cannot change
  -- mid-transaction.
  SELECT roster_size
    INTO v_roster_size
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Count the caller's current active (non-IR, non-taxi) roster slots. The
  -- prior roster_players FOR UPDATE on the player-id row also serialized
  -- concurrent adds for the same player; combined with the cap-row lock above,
  -- counting here is safe.
  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF v_active_count >= COALESCE(v_roster_size, 20) THEN
    -- Error message intentionally contains the word "full" — callers in
    -- app/(tabs)/players.tsx and app/player/[id].tsx match e.message?.includes('full')
    -- to surface the drop-picker UI.
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_roster_size, 20)
      USING ERRCODE = 'P0001';
  END IF;

  -- Defensive: clear any stale weekly_lineups rows for the incoming player
  -- in this league (consistent with the other atomic RPCs).
  DELETE FROM weekly_lineups
   WHERE league_id = p_league_id
     AND player_id = p_player_id;

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
$add_free_agent_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.add_free_agent_atomic(uuid, uuid, uuid) TO service_role';

  -- ────────────────────────────────────────────────────────────────────────
  -- drop_player_atomic
  -- Single roster row → derive (league_id, player_id) once located, then
  -- lock. We must look up the row first to know the player_id, but the
  -- only thing exposed before the lock is a SELECT FOR UPDATE on a single
  -- row by primary key — no concurrent RPC can act on the same player
  -- through this RPC's path without holding that row lock, and any
  -- non-drop RPC will block on the advisory lock once we take it.
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

  -- Now that we know the (league_id, player_id), take the advisory lock
  -- that serializes this mutation against add_free_agent_atomic, trade
  -- completion, and waiver-claim processing on the same tuple.
  PERFORM pg_advisory_xact_lock(
    hashtext(v_rp.league_id::text),
    hashtext(v_rp.player_id::text)
  );

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
  -- accept_trade_atomic (PHASE 1)
  -- The trade has multiple trade_items. Lock the trade row first, then
  -- iterate every distinct player_id in trade_items in ASCENDING order
  -- and take an advisory lock per (league_id, player_id). Ordering is
  -- deterministic so two concurrent multi-player RPCs touching the same
  -- player set cannot deadlock.
  -- Body otherwise byte-identical to 20260516190000 (the veto-window
  -- restoration) — only the trade-row lookup and the advisory-lock loop
  -- are new before the asset validation loop.
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
  -- complete_accepted_trade_atomic (PHASE 2)
  -- Same multi-player advisory-lock pattern as accept_trade_atomic.
  -- Body byte-identical to 20260516190000 except for the new lock loop.
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
  -- process_next_waiver_claim_atomic
  -- A claim touches one or two players: v_claim.player_id (always) and
  -- v_claim.drop_player_id (optional). Take advisory locks for both,
  -- ordered by player_id ASC. Locks are taken AFTER v_claim is loaded
  -- because we don't know which claim will be picked until after the
  -- priority-ordered SKIP LOCKED select. Body otherwise byte-identical
  -- to 20260516173100.
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
