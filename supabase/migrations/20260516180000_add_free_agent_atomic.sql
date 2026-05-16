-- Make the add-free-agent flow atomic.
--
-- Finding (iter 18, slice A):
-- - lib/roster.ts `addFreeAgent` did a client-side INSERT into roster_players
--   plus a roster_transactions audit row. Although RLS prevented cross-member
--   inserts, the function never checked whether the player was currently on
--   waivers (waiver_wire_log.cleared_at IS NULL AND clears_at > now()) nor did
--   it take a lock on the waiver row. Race window: between a concurrent
--   drop_player_atomic commit and another tab's getPlayerRosterStatus refresh,
--   the unguarded INSERT let a second user "scoop" a player off waivers,
--   leaving queued waiver_claims to fail.
--
-- Every other roster mutation (drop, trade, waiver-claim) is a SECURITY
-- DEFINER atomic RPC. This migration mirrors that pattern for the free-agent
-- add: it locks the waiver_wire_log row (if any) and any existing
-- roster_players row for the same player + season, validates the caller
-- actually owns the league_member, validates the active roster has space,
-- then inserts the new roster_players row + roster_transactions audit row in
-- one transaction. Additionally clears stale weekly_lineups rows for the
-- player (consistent with drop_player_atomic / accept_trade_atomic /
-- process_next_waiver_claim_atomic) so the daily scorer cannot credit a
-- prior owner after the add.
--
-- Idempotent: CREATE OR REPLACE plus REVOKE/GRANT inside a DO block.

DO $migration$
BEGIN
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
END
$migration$;
