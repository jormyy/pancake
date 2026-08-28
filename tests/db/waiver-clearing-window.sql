-- Waiver clearing window: a player whose 48-hour window has ended but whose
-- entry has not been processed yet stays on waivers. Free-agent adds keep
-- rejecting them (waiver priority must not lose to the fastest finger) and
-- claims keep being accepted until the run processes the entry.
-- Runs inside one transaction and rolls back.
BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-0000000c0001', 'authenticated', 'authenticated', 'window-a@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-0000000c0002', 'authenticated', 'authenticated', 'window-b@example.test', 'x', now(), '{}', '{}', now(), now());

INSERT INTO public.profiles (id, username, display_name)
VALUES
  ('00000000-0000-0000-0000-0000000c0001', 'window_a', 'Window A'),
  ('00000000-0000-0000-0000-0000000c0002', 'window_b', 'Window B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit)
VALUES ('00000000-0000-0000-0000-0000000c0101', 'Waiver Window', 'waiver-window', '00000000-0000-0000-0000-0000000c0001', 'active', 'faab', NULL);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-0000000c0201', '00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0001', 'commissioner', 'Team A'),
  ('00000000-0000-0000-0000-0000000c0202', '00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0002', 'manager', 'Team B');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-0000000c0301', '00000000-0000-0000-0000-0000000c0101', 2099, true);

INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
VALUES (2099, 1, current_date - 30, current_date + 400);

INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
VALUES
  ('00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0301', '00000000-0000-0000-0000-0000000c0201', 1),
  ('00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0301', '00000000-0000-0000-0000-0000000c0202', 2);

INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions, injury_status, nba_draft_number)
VALUES
  ('00000000-0000-0000-0000-0000000c0401', 'Due', 'Uncleared', 'LAL', 'C', 4, ARRAY['C'], NULL, 40),
  ('00000000-0000-0000-0000-0000000c0402', 'Still', 'Clearing', 'BOS', 'SG', 3, ARRAY['SG'], NULL, 20),
  ('00000000-0000-0000-0000-0000000c0403', 'Already', 'Cleared', 'MIA', 'PG', 2, ARRAY['PG'], NULL, 30);

-- Dropped by Team B: one entry past its window and unprocessed, one still
-- clearing, one processed on an earlier run.
INSERT INTO public.waiver_wire_log (league_id, league_season_id, player_id, dropped_by_member_id, placed_on_waivers_at, clears_at, cleared_at)
VALUES
  ('00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0301', '00000000-0000-0000-0000-0000000c0401', '00000000-0000-0000-0000-0000000c0202', now() - interval '3 days', now() - interval '20 hours', NULL),
  ('00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0301', '00000000-0000-0000-0000-0000000c0402', '00000000-0000-0000-0000-0000000c0202', now() - interval '1 hour', now() + interval '47 hours', NULL),
  ('00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0301', '00000000-0000-0000-0000-0000000c0403', '00000000-0000-0000-0000-0000000c0202', now() - interval '5 days', now() - interval '3 days', now() - interval '2 days');

CREATE TEMP TABLE window_ids AS
SELECT
  '00000000-0000-0000-0000-0000000c0101'::uuid AS league_id,
  '00000000-0000-0000-0000-0000000c0301'::uuid AS season_id,
  '00000000-0000-0000-0000-0000000c0001'::uuid AS user_a,
  '00000000-0000-0000-0000-0000000c0201'::uuid AS member_a,
  '00000000-0000-0000-0000-0000000c0202'::uuid AS member_b,
  '00000000-0000-0000-0000-0000000c0401'::uuid AS due_player,
  '00000000-0000-0000-0000-0000000c0402'::uuid AS clearing_player,
  '00000000-0000-0000-0000-0000000c0403'::uuid AS cleared_player;

-- T1: inside the window a free-agent add is still rejected as "on waivers".
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
DO $$
DECLARE ids window_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM window_ids;
  BEGIN
    PERFORM public.add_free_agent_atomic(ids.member_a, ids.league_id, ids.due_player);
    RAISE EXCEPTION 'T1: a due but unprocessed waiver player was added as a free agent';
  EXCEPTION WHEN SQLSTATE 'PA002' THEN
    IF SQLERRM NOT LIKE 'This player is on waivers%' THEN RAISE; END IF;
  END;
END $$;

-- T2: inside the window a claim is accepted and lands on the next run.
CREATE TEMP TABLE window_claims AS
SELECT public.create_waiver_claim_atomic(ids.league_id, ids.member_a, ids.due_player, NULL, ids.user_a, 0) AS due_claim,
       public.create_waiver_claim_atomic(ids.league_id, ids.member_a, ids.clearing_player, NULL, ids.user_a, 0) AS clearing_claim
  FROM window_ids AS ids;
DO $$
DECLARE ids window_ids%ROWTYPE; claims window_claims%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM window_ids;
  SELECT * INTO claims FROM window_claims;
  IF (SELECT process_date FROM public.waiver_claims WHERE id = claims.due_claim) > current_date THEN
    RAISE EXCEPTION 'T2: the claim on a due player waits past the next run';
  END IF;
  IF (SELECT status FROM public.waiver_claims WHERE id = claims.clearing_claim) <> 'pending' THEN
    RAISE EXCEPTION 'T2: the claim on a clearing player is not pending';
  END IF;
END $$;

-- T3: a claim on a processed entry is rejected; the player is a free agent now.
DO $$
DECLARE ids window_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM window_ids;
  BEGIN
    PERFORM public.create_waiver_claim_atomic(ids.league_id, ids.member_a, ids.cleared_player, NULL, ids.user_a, 0);
    RAISE EXCEPTION 'T3: a claim was accepted for a player whose entry was processed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'This player is no longer on waivers%' THEN RAISE; END IF;
  END;
  PERFORM public.add_free_agent_atomic(ids.member_a, ids.league_id, ids.cleared_player);
END $$;

-- T4: the run processes the due claim and leaves the clearing entry alone.
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT count(*) FROM public.process_next_waiver_claim_atomic(current_date);
DO $$
DECLARE ids window_ids%ROWTYPE; claims window_claims%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM window_ids;
  SELECT * INTO claims FROM window_claims;
  IF (SELECT status FROM public.waiver_claims WHERE id = claims.due_claim) <> 'succeeded' THEN
    RAISE EXCEPTION 'T4: the claim on the due player did not succeed: %',
      (SELECT COALESCE(failure_reason, status) FROM public.waiver_claims WHERE id = claims.due_claim);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_players WHERE member_id = ids.member_a AND player_id = ids.due_player) THEN
    RAISE EXCEPTION 'T4: the due player did not reach the roster';
  END IF;
  IF EXISTS (SELECT 1 FROM public.waiver_wire_log WHERE player_id = ids.due_player AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'T4: the due entry was not cleared by the run';
  END IF;
  IF (SELECT status FROM public.waiver_claims WHERE id = claims.clearing_claim) <> 'pending'
     OR NOT EXISTS (SELECT 1 FROM public.waiver_wire_log WHERE player_id = ids.clearing_player AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'T4: the run touched the entry that is still clearing';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'waiver-clearing-window: T1-T4 passed'; END $$;

ROLLBACK;
