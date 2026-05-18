-- ──────────────────────────────────────────────────────────────────────────
-- update_league_settings_atomic: status='setup' gate for structural changes
-- ──────────────────────────────────────────────────────────────────────────
-- Problem (SLICE C, iter 36):
--   lib/league.ts `updateLeague()` issued a direct PostgREST UPDATE against
--   public.leagues with whatever subset of settings columns the commissioner-
--   settings screen happened to send (scoring_settings, roster_size, ir_slots,
--   taxi_slots, auction_budget, playoff_start_week). The column-level GRANT
--   from 20260516300000_leagues_column_grants.sql restricted which columns
--   could be written but did NOT restrict WHEN they could be written.
--
--   A commissioner could therefore mutate "structural" settings — those that
--   shape the league's economic and competitive contract for the whole
--   season — at any point in the league lifecycle, including mid-season:
--
--     • scoring_settings — alter point weights mid-season. Past weeks would
--       keep their stored fantasy_points totals, but syncScores (and the
--       compute_fantasy_points RPC) re-derive the *current* and *previous*
--       week from raw stat rows on every refresh, so the new weights would
--       silently rewrite already-shipped matchup outcomes within that
--       window. Standings + waiver priority + playoff seeding all drift.
--     • roster_size — shrink the cap to a value below an existing roster's
--       active count. Existing roster_players rows survive (no cascading
--       DELETE), but every subsequent add_free_agent_atomic /
--       process_next_waiver_claim_atomic check against COALESCE(roster_size,
--       20) starts rejecting legitimate moves on rosters that are now
--       "over capacity" through no fault of the owner. Conversely, growing
--       the cap mid-season hands every roster free slots that other leagues
--       would not have, distorting trade economics.
--     • ir_slots / taxi_slots — same shape as roster_size. The IR / taxi
--       enforcement RPCs (toggle_ir_atomic, toggle_taxi_atomic) read the
--       cap fresh per call; raising it mid-season hands every roster a
--       midseason stash of high-upside / injured players that competing
--       leagues did not get.
--     • auction_budget — only meaningful pre-draft. Changing it after the
--       draft has run leaves draft_budgets rows (computed at create_league /
--       start_auction time) misaligned with the leagues.auction_budget
--       cap, breaking downstream waiver-budget logic.
--
--   The only settings that are LEGITIMATELY commissioner-tunable mid-season
--   are policy knobs that do not retroactively rewrite prior outcomes:
--
--     • playoff_start_week — moves the regular-season / playoff boundary.
--       Used to extend the regular season after a schedule shock.
--     • trade_deadline — closes (or re-opens, with notice) the trade
--       window. Used to react to commissioner consensus mid-season.
--
-- Fix:
--   New SECURITY DEFINER RPC public.update_league_settings_atomic. Caller
--   passes a jsonb bag with any subset of the seven supported keys. The
--   function:
--
--     1. Verifies the caller is a commissioner (or co-commissioner) of the
--        league via the private.is_commissioner helper. This mirrors the
--        leagues_update RLS policy we bypass via DEFINER.
--     2. Takes a row-level FOR UPDATE lock on the leagues row so the
--        status check + write are serialized against any concurrent
--        lifecycle RPC (set_league_status_atomic, advance_season_atomic,
--        etc.).
--     3. Reads the locked row's `status`.
--     4. If status IS DISTINCT FROM 'setup', rejects the request when
--        the bag contains ANY of the four structural keys:
--          scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget.
--        (auction_budget is included with the structural keys because it
--        is meaningful only pre-draft and changing it after the draft
--        corrupts draft_budgets / waiver-budget math.)
--     5. UPDATEs only the columns the caller actually supplied, using
--        COALESCE(p_settings -> key, existing_value) so missing keys are
--        no-ops. Keys present with explicit nulls also no-op (the jsonb
--        '->' operator returns SQL NULL for both "missing" and
--        "null-valued").
--     6. Validates and casts each value: scoring_settings is itself a
--        jsonb; the rest are positive ints.
--
--   playoff_start_week and trade_deadline pass the status gate regardless
--   of leagues.status, so the commissioner-settings screen can still tune
--   them after the draft has shipped.
--
-- Why a single RPC and not column-level CHECK constraints:
--   PostgreSQL row CHECK constraints cannot read the leagues.status of the
--   row being updated easily (no OLD/NEW from a constraint), and an UPDATE
--   trigger that conditionally aborts based on status would also need to
--   compare OLD/NEW column-by-column — the same logic, just spread across
--   trigger + grant + RLS. Centralizing in a SECURITY DEFINER RPC keeps
--   all the policy in one place and matches the convention of every other
--   atomic RPC in this repo.
--
-- Frontend / backend impact:
--   • lib/league.ts updateLeague() — switched in the same slice to call
--     this RPC; preserves its TypeScript signature.
--   • app/(modals)/commissioner-settings.tsx — UNAFFECTED. It goes through
--     updateLeague().
--   • Backend lifecycle scripts (set_league_status, advance_season, etc.)
--     — UNAFFECTED. They use the service-role client and bypass both RLS
--     and this RPC.
--
-- Authentication / authorization:
--   • EXECUTE granted to authenticated + service_role only. anon and
--     PUBLIC are revoked. The first line of the function checks
--     auth.uid() so an unauthenticated PostgREST call (impossible with
--     the grant above, but defense in depth) bails out cleanly.
--   • private.is_commissioner reads league_members.role and is itself a
--     SECURITY DEFINER helper that respects auth.uid() via the JWT.
--
-- Idempotency:
--   CREATE OR REPLACE + the REVOKE/GRANT block are naturally idempotent.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_league_settings_atomic(
  p_league_id uuid,
  p_settings  jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league             public.leagues%ROWTYPE;
  v_user_id            uuid := (SELECT auth.uid());
  v_touches_structural boolean;

  -- Parsed values. NULL when the corresponding key is absent from the
  -- jsonb bag (or present-but-null, which we treat as absent). All seven
  -- supported keys.
  v_scoring_settings   jsonb;
  v_roster_size        int;
  v_ir_slots           int;
  v_taxi_slots         int;
  v_auction_budget     int;
  v_playoff_start_week int;
  v_trade_deadline     timestamptz;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  -- Lock the leagues row so the status check and the write are serialized
  -- against any concurrent lifecycle RPC (set_league_status_atomic,
  -- advance_season_atomic, etc.).
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
  -- Mirrors the leagues_update RLS USING clause that we bypass via
  -- SECURITY DEFINER.
  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can change settings.'
      USING ERRCODE = '42501';
  END IF;

  -- Parse each supported key. jsonb '->' returns SQL NULL for both
  -- "missing" and "present-but-null"; treat both as no-op.
  IF p_settings ? 'scoring_settings' AND jsonb_typeof(p_settings -> 'scoring_settings') = 'object' THEN
    v_scoring_settings := p_settings -> 'scoring_settings';
  END IF;

  IF p_settings ? 'roster_size' AND jsonb_typeof(p_settings -> 'roster_size') = 'number' THEN
    v_roster_size := (p_settings ->> 'roster_size')::int;
    IF v_roster_size IS NULL OR v_roster_size <= 0 THEN
      RAISE EXCEPTION 'roster_size must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'ir_slots' AND jsonb_typeof(p_settings -> 'ir_slots') = 'number' THEN
    v_ir_slots := (p_settings ->> 'ir_slots')::int;
    IF v_ir_slots IS NULL OR v_ir_slots < 0 THEN
      RAISE EXCEPTION 'ir_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'taxi_slots' AND jsonb_typeof(p_settings -> 'taxi_slots') = 'number' THEN
    v_taxi_slots := (p_settings ->> 'taxi_slots')::int;
    IF v_taxi_slots IS NULL OR v_taxi_slots < 0 THEN
      RAISE EXCEPTION 'taxi_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'auction_budget' AND jsonb_typeof(p_settings -> 'auction_budget') = 'number' THEN
    v_auction_budget := (p_settings ->> 'auction_budget')::int;
    IF v_auction_budget IS NULL OR v_auction_budget <= 0 THEN
      RAISE EXCEPTION 'auction_budget must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_start_week' AND jsonb_typeof(p_settings -> 'playoff_start_week') = 'number' THEN
    v_playoff_start_week := (p_settings ->> 'playoff_start_week')::int;
    IF v_playoff_start_week IS NULL OR v_playoff_start_week <= 0 THEN
      RAISE EXCEPTION 'playoff_start_week must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_deadline' AND p_settings -> 'trade_deadline' IS NOT NULL THEN
    -- timestamptz can be either a JSON string (ISO 8601) or null.
    IF jsonb_typeof(p_settings -> 'trade_deadline') <> 'string' THEN
      RAISE EXCEPTION 'trade_deadline must be an ISO 8601 timestamp string.'
        USING ERRCODE = '22023';
    END IF;
    v_trade_deadline := (p_settings ->> 'trade_deadline')::timestamptz;
  END IF;

  -- Structural-key detector. These keys may only be changed while the
  -- league is in 'setup'. auction_budget is included because changing it
  -- after the draft has run corrupts already-allocated draft_budgets.
  v_touches_structural :=
       v_scoring_settings IS NOT NULL
    OR v_roster_size      IS NOT NULL
    OR v_ir_slots         IS NOT NULL
    OR v_taxi_slots       IS NOT NULL
    OR v_auction_budget   IS NOT NULL;

  IF v_touches_structural
     AND v_league.status IS DISTINCT FROM 'setup'::public.league_status
  THEN
    RAISE EXCEPTION
      'Structural league settings (scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget) can only be changed before the draft starts.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Apply the UPDATE. COALESCE preserves the existing column when the
  -- corresponding parsed variable is NULL (key was absent / explicitly
  -- null / wrong type). This keeps the call site idiomatic: pass only
  -- the keys you want to change.
  UPDATE public.leagues
     SET scoring_settings   = COALESCE(v_scoring_settings,   scoring_settings),
         roster_size        = COALESCE(v_roster_size,        roster_size),
         ir_slots           = COALESCE(v_ir_slots,           ir_slots),
         taxi_slots         = COALESCE(v_taxi_slots,         taxi_slots),
         auction_budget     = COALESCE(v_auction_budget,     auction_budget),
         playoff_start_week = COALESCE(v_playoff_start_week, playoff_start_week),
         trade_deadline     = COALESCE(v_trade_deadline,     trade_deadline)
   WHERE id = p_league_id;
END;
$$;

-- Lockdown grants — match the convention of every other DEFINER RPC in
-- this repo. PUBLIC + anon get nothing; authenticated + service_role
-- get EXECUTE.
REVOKE ALL ON FUNCTION public.update_league_settings_atomic(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_league_settings_atomic(uuid, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.update_league_settings_atomic(uuid, jsonb) IS
  'Commissioner-only league-settings writer. Validates leagues.status = ''setup'' '
  'for structural keys (scoring_settings, roster_size, ir_slots, taxi_slots, '
  'auction_budget); allows playoff_start_week and trade_deadline at any '
  'lifecycle stage. Replaces the direct PostgREST UPDATE in lib/league.ts '
  'updateLeague().';
