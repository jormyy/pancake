-- Make the rookie (snake) draft pick flow atomic.
--
-- Finding (iter 22, slice A):
-- - sync/rookieDraft.ts `makeSnakePick` performed 5+ separate statements with no
--   lock between them:
--     1. SELECT drafts (status check)
--     2. SELECT snake_draft_picks (next null pick, then `member_id` validation)
--     3. SELECT roster_players (already-on-roster check)
--     4. SELECT snake_draft_picks (already-picked-in-draft check)
--     5. UPDATE snake_draft_picks (record the pick)
--     6. INSERT roster_players
--     7. UPDATE draft_picks (mark used)
--     8. (when last pick) UPDATE drafts + UPDATE leagues
--   Two rapid submits with different players (manual+auto-pick race, or a
--   double-tap that sends two distinct payloads) could both pass validation,
--   then T2's UPDATE on the snake_draft_picks row clobbered T1's player_id
--   while T2's roster_players INSERT also succeeded — leaving an orphan
--   roster_players row whose pick slot now points at a different player.
--
-- Every other roster-mutating writer (drop, add, trade, waiver) is a
-- SECURITY DEFINER atomic RPC with an advisory xact lock; this is the last
-- unprotected mutating path. The RPC below:
--   * Takes pg_advisory_xact_lock(draft_id, overall_pick=0) to serialize all
--     callers for a given draft.
--   * Takes the (league_id, player_id) lock used by every other roster
--     mutation, so a snake-draft pick cannot race against a concurrent
--     drop/add/trade/waiver attempting to touch the same player.
--   * Locks the next null pick row FOR UPDATE.
--   * Re-validates draft status, member ownership, player not on any roster
--     in this season, and player not already drafted.
--   * Writes snake_draft_picks UPDATE + roster_players INSERT + draft_picks
--     UPDATE in one transaction.
--   * When the last pick is filled, also marks drafts.status='completed' and
--     leagues.status='active' atomically.
--
-- Returns JSONB carrying the pick metadata + remaining count so the TS caller
-- can preserve its existing return shape (used by routes/draft.ts and
-- autoPickBest, plus the rookieDraft.test.ts asserts).
--
-- Backend pancake service uses the service-role key, so auth.uid() is NULL in
-- this RPC's context. The caller (routes/draft.ts → verifyMemberAccess) has
-- already authorized the operation against req.userId before invoking
-- makeSnakePick; the RPC trusts the validated p_member_id the same way
-- accept_trade_atomic / close_auction_nomination_atomic do. We grant EXECUTE
-- to service_role only.
--
-- Idempotent: CREATE OR REPLACE plus REVOKE/GRANT inside a DO block.

DO $migration$
BEGIN
  EXECUTE $make_snake_pick_sql$
CREATE OR REPLACE FUNCTION public.make_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_season_year int;
  v_next_pick snake_draft_picks%ROWTYPE;
  v_on_roster_id uuid;
  v_already_picked_id uuid;
  v_now timestamptz := now();
  v_remaining int;
  v_completed boolean := false;
  v_fallback_pick_id uuid;
BEGIN
  -- Serialize every snake-draft pick for the same draft. Using overall_pick=0
  -- (a value no real snake_draft_picks row can have, since overall_pick starts
  -- at 1) as the second key keeps this lock distinct from anything else that
  -- might key on (draft_id, overall_pick).
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  -- Lock the draft row and validate status. The drafts row also gets a write
  -- lock here so concurrent draft-status changes (e.g., commissioner
  -- intervention) cannot race with our completion update below.
  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress' USING ERRCODE = 'P0001';
  END IF;

  -- Also serialize against every other roster-mutating RPC for this player.
  -- A concurrent free-agent add / drop / trade / waiver claim touching the
  -- same player in this league must wait for our pick to commit.
  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_player_id::text)
  );

  -- Resolve the draft's season_year for the legacy draft_picks fallback path.
  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = v_draft.league_season_id;

  -- Lock the next unpicked slot. This is the row that both racing callers
  -- would have read; FOR UPDATE blocks the second caller until the first
  -- commits its UPDATE, after which the second caller will see player_id
  -- non-null and skip to the NEXT slot.
  SELECT *
    INTO v_next_pick
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
   ORDER BY overall_pick
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No picks remaining — draft may be complete'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_next_pick.member_id <> p_member_id THEN
    RAISE EXCEPTION 'It''s not your pick'
      USING ERRCODE = 'P0001';
  END IF;

  -- Check player is not already on any roster in this season. Locking the
  -- row (if it exists) closes the window against a concurrent trade / waiver
  -- write to the same player.
  SELECT id
    INTO v_on_roster_id
    FROM roster_players
   WHERE league_id = v_draft.league_id
     AND league_season_id = v_draft.league_season_id
     AND player_id = p_player_id
   FOR UPDATE;

  IF v_on_roster_id IS NOT NULL THEN
    RAISE EXCEPTION 'Player is already on a roster' USING ERRCODE = '23505';
  END IF;

  -- Defensive: ensure the player has not already been picked in this draft.
  -- The (draft_id, overall_pick) advisory lock above already serializes
  -- snake picks for this draft, but cron/seed paths could in principle
  -- insert a duplicate; check explicitly.
  SELECT id
    INTO v_already_picked_id
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id = p_player_id
   LIMIT 1;

  IF v_already_picked_id IS NOT NULL THEN
    RAISE EXCEPTION 'Player already picked in this draft'
      USING ERRCODE = '23505';
  END IF;

  -- Record the pick.
  UPDATE snake_draft_picks
     SET player_id = p_player_id,
         picked_at = v_now
   WHERE id = v_next_pick.id;

  -- Add to roster (acquired_via='draft' matches both the prior TS behavior
  -- and the auction draft RPC at 20260512000006).
  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    acquired_via
  )
  VALUES (
    v_draft.league_id,
    v_draft.league_season_id,
    p_member_id,
    p_player_id,
    'draft'
  );

  -- Mark the exact draft_pick asset as used. Older snake_draft_picks rows
  -- may not have draft_pick_id populated (pre-20260512000003); fall back to
  -- the (league_id, current_owner_id, round, season_year, is_used=false)
  -- match — same semantics as the prior TS code.
  IF v_next_pick.draft_pick_id IS NOT NULL THEN
    UPDATE draft_picks
       SET is_used = true,
           used_at = v_now,
           rookie_draft_id = p_draft_id
     WHERE id = v_next_pick.draft_pick_id
       AND current_owner_id = p_member_id
       AND is_used = false;
  ELSE
    -- Resolve a fallback pick id deterministically (LIMIT 1 on the same
    -- conditions the TS used) so we never update more than one row.
    SELECT id
      INTO v_fallback_pick_id
      FROM draft_picks
     WHERE league_id = v_draft.league_id
       AND current_owner_id = p_member_id
       AND round = v_next_pick.round
       AND is_used = false
       AND (v_season_year IS NULL OR season_year = v_season_year)
     ORDER BY season_year, round
     LIMIT 1;

    IF v_fallback_pick_id IS NOT NULL THEN
      UPDATE draft_picks
         SET is_used = true,
             used_at = v_now,
             rookie_draft_id = p_draft_id
       WHERE id = v_fallback_pick_id;
    END IF;
  END IF;

  -- Count remaining null picks. Done inside the transaction so the completion
  -- check is based on the just-committed state.
  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL;

  IF v_remaining = 0 THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = v_now
     WHERE id = p_draft_id;

    UPDATE leagues
       SET status = 'active'
     WHERE id = v_draft.league_id;

    v_completed := true;
  END IF;

  RETURN jsonb_build_object(
    'pick', jsonb_build_object(
      'id', v_next_pick.id,
      'overall_pick', v_next_pick.overall_pick,
      'round', v_next_pick.round,
      'pick_in_round', v_next_pick.pick_in_round,
      'member_id', v_next_pick.member_id,
      'draft_pick_id', v_next_pick.draft_pick_id
    ),
    'remaining', v_remaining,
    'completed', v_completed,
    'league_id', v_draft.league_id,
    'league_season_id', v_draft.league_season_id
  );
END;
$$;
$make_snake_pick_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) TO service_role';
END
$migration$;
