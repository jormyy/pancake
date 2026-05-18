-- ──────────────────────────────────────────────────────────────────────────
-- update_lineup_slots_atomic: status='setup' gate for lineup slot templates
-- ──────────────────────────────────────────────────────────────────────────
-- Problem (SLICE A, iter 39):
--   lib/league.ts `updateLineupSlots()` issued a direct PostgREST UPSERT
--   against public.lineup_slot_templates. The slot_templates_insert /
--   slot_templates_update RLS policies gated WHO could write
--   (private.is_commissioner) but did NOT gate WHEN: a commissioner could
--   rewrite the league's starting lineup at any lifecycle stage, including
--   mid-season.
--
--   This was a parallel direct-write path that bypassed the structural-
--   settings gate introduced in 20260516360000_update_league_settings_atomic.
--   That migration locked scoring_settings, roster_size, ir_slots,
--   taxi_slots, auction_budget to status='setup' on the leagues row, but
--   the slot layout (e.g. PG×1 SG×1 ... UTIL×1 BE×12 IR×2) is just as
--   structural — it determines which positions are starters and therefore
--   which players accrue weekly fantasy points.
--
--   Mid-season exploit shape:
--     • Commissioner shrinks PF: 2 → 1 at week 8. The auto_set_lineup
--       and set_player_slot RPCs read lineup_slot_templates fresh per
--       call to bound each position; from week 8 forward, only one PF
--       starts per matchup per day. Owners of two-PF rosters who built
--       around the original layout are silently penalized.
--     • Commissioner grows UTIL: 1 → 3 mid-playoff. Suddenly every
--       roster has more starter slots, distorting the weekly point
--       ceiling against the regular-season baseline.
--     • Commissioner inserts an IR slot mid-season. The IR cap on the
--       leagues row is separately gated (iter 36) but the slot template
--       row controls which slot_types are valid starters — adding a new
--       row is a structural rewrite of the lineup rules.
--
-- Fix:
--   New SECURITY DEFINER RPC public.update_lineup_slots_atomic. Caller
--   passes a jsonb array of { slot_type, slot_count } objects. The
--   function:
--
--     1. Verifies the caller is authenticated.
--     2. Validates p_slots is a jsonb array.
--     3. Takes a row-level FOR UPDATE lock on the leagues row so the
--        status check + write are serialized against any concurrent
--        lifecycle RPC (set_league_status_atomic, advance_season_atomic,
--        update_league_settings_atomic).
--     4. Verifies the caller is a commissioner (or co-commissioner) of
--        the league via private.is_commissioner. Mirrors the previously
--        active slot_templates_insert/update WITH CHECK clauses we now
--        bypass via SECURITY DEFINER.
--     5. If v_league.status IS DISTINCT FROM 'setup', rejects the request
--        with a user-facing P0001 error.
--     6. Iterates the jsonb array, INSERT ... ON CONFLICT (league_id,
--        slot_type) DO UPDATE SET slot_count for each entry. Validates
--        slot_type against the roster_slot_type enum and slot_count > 0.
--
--   Direct INSERT/UPDATE/DELETE on lineup_slot_templates is REVOKEd from
--   authenticated so the previous direct-write path is closed. The
--   slot_templates_insert/update/delete RLS policies remain on the table
--   as defense-in-depth: even if a future grant were re-introduced, the
--   WITH CHECK would still require commissioner role. SELECT remains open
--   to league members so the commissioner-settings screen can read the
--   current layout via getLineupSlots().
--
-- Frontend / backend impact:
--   • lib/league.ts updateLineupSlots() — switched in the same slice to
--     call this RPC; preserves its TypeScript signature.
--   • app/(modals)/commissioner-settings.tsx — UNAFFECTED. It goes
--     through updateLineupSlots().
--   • create_league trigger (20260226000003_functions.sql line 52) and
--     20260325000008_seed_lineup_slots.sql — UNAFFECTED. Both run as
--     SECURITY DEFINER / superuser at table-init time, not via the
--     authenticated PostgREST grant we are revoking.
--   • Backend lifecycle scripts — UNAFFECTED. They use the service-role
--     client which retains its grants (REVOKE here targets authenticated
--     only).
--
-- Authentication / authorization:
--   • EXECUTE granted to authenticated + service_role only. PUBLIC + anon
--     are revoked. The first line of the function checks auth.uid().
--   • private.is_commissioner reads league_members.role and is itself a
--     SECURITY DEFINER helper that respects auth.uid() via the JWT.
--
-- Idempotency:
--   CREATE OR REPLACE + the REVOKE/GRANT block are naturally idempotent.
--   REVOKE on the underlying table is also idempotent — repeated calls
--   are no-ops if the privilege was already absent.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_lineup_slots_atomic(
  p_league_id uuid,
  p_slots     jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league       public.leagues%ROWTYPE;
  v_user_id      uuid := (SELECT auth.uid());
  v_entry        jsonb;
  v_slot_type    public.roster_slot_type;
  v_slot_count   int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RAISE EXCEPTION 'p_slots must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  -- Lock the leagues row so the status check and the writes are serialized
  -- against any concurrent lifecycle RPC (set_league_status_atomic,
  -- advance_season_atomic, update_league_settings_atomic, etc.).
  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Authorization: commissioner / co-commissioner of THIS league only.
  -- Mirrors the slot_templates_insert/update RLS WITH CHECK clauses we
  -- bypass via SECURITY DEFINER.
  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can change lineup slots.'
      USING ERRCODE = '42501';
  END IF;

  -- Status gate: the lineup-slot layout determines which positions are
  -- starters and therefore which players accrue weekly fantasy points.
  -- Changing it after the draft has shipped silently rewrites the
  -- competitive contract of the league. Only 'setup' is allowed.
  IF v_league.status IS DISTINCT FROM 'setup'::public.league_status THEN
    RAISE EXCEPTION 'Lineup slots can only be modified during setup.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Iterate the jsonb array and upsert each entry. ON CONFLICT mirrors
  -- the prior client-side upsert(rows, { onConflict: 'league_id,slot_type' }).
  FOR v_entry IN
    SELECT value FROM jsonb_array_elements(p_slots)
  LOOP
    IF v_entry IS NULL OR jsonb_typeof(v_entry) <> 'object' THEN
      RAISE EXCEPTION 'Each slot entry must be a JSON object.'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (v_entry ? 'slot_type') OR jsonb_typeof(v_entry -> 'slot_type') <> 'string' THEN
      RAISE EXCEPTION 'slot_type is required and must be a string.'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (v_entry ? 'slot_count') OR jsonb_typeof(v_entry -> 'slot_count') <> 'number' THEN
      RAISE EXCEPTION 'slot_count is required and must be a number.'
        USING ERRCODE = '22023';
    END IF;

    -- Cast to roster_slot_type. An invalid enum value raises 22P02 with
    -- a clear "invalid input value for enum" message, which is good
    -- enough for the client error path.
    v_slot_type := (v_entry ->> 'slot_type')::public.roster_slot_type;
    v_slot_count := (v_entry ->> 'slot_count')::int;

    IF v_slot_count IS NULL OR v_slot_count <= 0 THEN
      RAISE EXCEPTION 'slot_count must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.lineup_slot_templates (league_id, slot_type, slot_count)
    VALUES (p_league_id, v_slot_type, v_slot_count)
    ON CONFLICT (league_id, slot_type)
    DO UPDATE SET slot_count = EXCLUDED.slot_count;
  END LOOP;
END;
$$;

-- Lockdown grants — match the convention of every other DEFINER RPC in
-- this repo. PUBLIC + anon get nothing; authenticated + service_role
-- get EXECUTE.
REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_lineup_slots_atomic(uuid, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.update_lineup_slots_atomic(uuid, jsonb) IS
  'Commissioner-only lineup-slot writer. Validates leagues.status = ''setup'' '
  'so the starting-lineup layout cannot be rewritten mid-season. Replaces '
  'the direct PostgREST UPSERT in lib/league.ts updateLineupSlots().';

-- ──────────────────────────────────────────────────────────────────────────
-- Close the direct-write path. The parallel slot_templates_insert /
-- slot_templates_update / slot_templates_delete RLS policies remain on
-- the table as defense-in-depth (they still require commissioner role
-- via WITH CHECK), but without the underlying table grant authenticated
-- callers can no longer reach those policies. service_role bypasses RLS
-- and keeps full access for backend lifecycle scripts.
-- ──────────────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE
  ON public.lineup_slot_templates
  FROM authenticated;
