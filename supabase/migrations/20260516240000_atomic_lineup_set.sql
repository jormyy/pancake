-- Atomic lineup set / auto-set RPCs.
--
-- Finding (iter 24, slice A):
-- - lib/lineup/read.ts `setPlayerSlot` and lib/lineup/autoSet.ts `autoSetForDate`
--   write directly to weekly_lineups from the client without any lock or
--   ownership re-check. Two concurrent flows can corrupt a member's lineup:
--     * Two devices firing autoSetLineup for the same (member, game_date)
--       interleave their read-then-DELETE-then-INSERT sequences. Device A
--       reads existing entries, Device B reads them too, Device A deletes
--       and inserts its own picks, Device B deletes and inserts its own
--       picks — final state is whichever device commits second, but the
--       unique constraint may have temporarily fired in between, or rows
--       from one device's intermediate state could leak through.
--     * A setPlayerSlot UPSERT racing with drop_player_atomic: the user
--       slots player X at the same moment a co-commissioner / waiver
--       processor drops X from their roster. setPlayerSlot has no roster
--       ownership check, so the lineup row is written for a player the
--       member no longer owns. The daily scorer (calcWeekPointsByMember)
--       then credits points for X to that member even though X has been
--       waivers'd to a new team.
-- - The clear_weekly_lineups_on_roster_moves migration (20260516173100)
--   DELETEs weekly_lineups when a roster row is removed inside the same
--   atomic RPC. But if setPlayerSlot's INSERT commits AFTER the DELETE,
--   the lineup row resurfaces and the scorer sees it.
--
-- Strategy: introduce two SECURITY DEFINER RPCs.
--   set_player_slot_atomic(p_member_id, p_league_id, p_league_season_id,
--                          p_player_id, p_game_date, p_slot_type)
--   auto_set_lineup_atomic(p_member_id, p_league_id, p_league_season_id,
--                          p_game_date, p_assignments jsonb)
--
-- Each RPC:
--   1. PERFORM pg_advisory_xact_lock(hashtext(member_id::text),
--      hashtext(game_date::text)) — serializes every lineup mutation on
--      the same (member_id, game_date) tuple. Two concurrent autoSets
--      from different devices for the same day will queue, the second
--      seeing the first's writes.
--   2. Verify the caller (auth.uid()) owns the league_member.
--   3. Re-verify every player_id is currently in roster_players for
--      (member_id, league_season_id) using SELECT … FOR SHARE. The FOR
--      SHARE blocks against a concurrent drop_player_atomic /
--      accept_trade_atomic / process_next_waiver_claim_atomic
--      SELECT … FOR UPDATE on the same row, so the ownership check
--      cannot go stale between read and commit.
--   4. Mutate weekly_lineups: UPSERT (single slot) or DELETE-all + INSERT
--      the JSONB assignments (auto-set).
--
-- Lock-key disjointness (deadlock safety):
-- - Lineup RPCs lock on (member_id, game_date) advisory keys, plus FOR
--   SHARE on roster_players rows for the affected player IDs.
-- - All other roster-mutating RPCs (add_free_agent_atomic,
--   drop_player_atomic, accept_trade_atomic, complete_accepted_trade_atomic,
--   process_next_waiver_claim_atomic, toggle_ir_atomic, toggle_taxi_atomic)
--   lock on (league_id, player_id) advisory keys, plus FOR UPDATE on
--   their own roster_players row.
-- - Advisory key spaces never overlap: (member_id, game_date) vs
--   (league_id, player_id). Two RPCs from different families can each
--   acquire their advisory locks without ever waiting on the other.
-- - On the roster_players row level, a lineup RPC holds FOR SHARE and a
--   roster RPC holds FOR UPDATE — they queue but cannot deadlock because
--   each RPC family acquires its own row locks in a single deterministic
--   order (lineup: sorted assignments player_id; roster RPCs were already
--   deadlock-safe per 20260516200000).
-- - Within the lineup family, auto_set_lineup_atomic acquires FOR SHARE
--   in player_id ASC order; set_player_slot_atomic acquires a single
--   FOR SHARE — no cycle possible.

DO $migration$
BEGIN
  -- ────────────────────────────────────────────────────────────────────────
  -- set_player_slot_atomic
  --
  -- Single-slot mutation. When p_slot_type = 'BE' deletes the row (the
  -- prior client UPSERT semantic) — otherwise UPSERTs onto the
  -- (league, season, member, player, date) unique key.
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
  -- auto_set_lineup_atomic
  --
  -- Replaces the entire day's lineup for (member_id, game_date) with the
  -- caller-supplied assignments. The client is responsible for honoring
  -- locked-player rules (started games) by including them in
  -- p_assignments with their original slot_type / is_auto_set values.
  --
  -- p_assignments is a JSON array of:
  --   [{"player_id": "<uuid>", "slot_type": "PG"|...|"BE", "is_auto_set": true,
  --     "week_number": 20}, ...]
  -- BE rows are filtered out (bench is implicit). Empty array = all
  -- starters dropped to bench.
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
