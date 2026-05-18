-- ──────────────────────────────────────────────────────────────────────────
-- add_free_agent_atomic: gate on leagues.status IN ('active','playoffs')
-- ──────────────────────────────────────────────────────────────────────────
-- Problem (SLICE B, iter 37):
--   The SECURITY DEFINER RPC add_free_agent_atomic (20260516180000) only
--   locked leagues for roster_size; it never validated leagues.status. A
--   league_member therefore could insert roster_players rows during
--   'setup' / 'drafting' (entirely bypassing the draft) or after
--   'offseason' / 'archived' (mutating rosters for a wound-down season).
--   Roster mutations of any kind should only be allowed while a season is
--   in-flight, i.e. status IN ('active', 'playoffs').
--
-- Fix:
--   Fold the existing roster_size lookup into a full v_league fetch
--   (still FOR UPDATE — preserving the cap-row lock that serializes the
--   active-slot count below). After the row is locked, raise a user-facing
--   P0001 error unless the status is 'active' or 'playoffs'. Every other
--   line of logic — caller-owns-member check, season lookup, IR-eligibility
--   gate, waiver-row lock, player-already-rostered lock, roster-cap count,
--   weekly_lineups sweep, roster_players insert, roster_transactions audit —
--   is preserved verbatim from 20260516180000.
--
-- Grants:
--   The grants established in 20260516180000 (REVOKE FROM PUBLIC/anon;
--   GRANT EXECUTE TO authenticated, service_role) are re-issued here so
--   the migration is self-contained and idempotent.
-- ──────────────────────────────────────────────────────────────────────────

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
  v_league leagues%ROWTYPE;
  v_season_id uuid;
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

  -- Fetch and lock the league row. The lock preserves the previous
  -- behavior of pinning the roster_size cap for the active-slot count
  -- below; folding the full row into v_league lets us additionally gate
  -- on lifecycle status without a second round-trip.
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Status gate: roster mutations only make sense once a season is in-flight.
  -- 'setup' / 'drafting' would bypass the draft; 'offseason' / 'archived'
  -- would mutate a wound-down season.
  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Free-agent adds require an active or playoff season.'
      USING ERRCODE = 'P0001';
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

  IF v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    -- Error message intentionally contains the word "full" — callers in
    -- app/(tabs)/players.tsx and app/player/[id].tsx match e.message?.includes('full')
    -- to surface the drop-picker UI.
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
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
