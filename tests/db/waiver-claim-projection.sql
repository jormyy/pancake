-- Records what the claim path does today (probes P5/P6 2026-09-12): a claim
-- with no drop on a full roster, and a claim whose drop player is dropped
-- before processing, are both accepted at create time and fail at processing.
-- This pins current behaviour; whether to refuse earlier is an open rule.
BEGIN;
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000071001', 'authenticated', 'authenticated', 'claim-projection@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, username, display_name) VALUES ('00000000-0000-0000-0000-000000071001', 'claim_projection', 'Claim Projection') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit, roster_size)
VALUES ('00000000-0000-0000-0000-000000071101', 'Claim Projection League', 'claim-projection-league', '00000000-0000-0000-0000-000000071001', 'active', 'rolling', NULL, 1);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES ('00000000-0000-0000-0000-000000071201', '00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071001', 'commissioner', 'Projection');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071101', 2096, true);
INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
VALUES ('00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071201', 1);
INSERT INTO public.players (id, sportsdata_id, first_name, last_name, position, eligible_positions, status, nba_team) VALUES
  ('00000000-0000-0000-0000-000000071401', 'claim-proj-rostered', 'Rostered', 'One', 'PG', ARRAY['PG'], 'Active', 'SIM'),
  ('00000000-0000-0000-0000-000000071402', 'claim-proj-waived-a', 'Waived', 'A', 'SG', ARRAY['SG'], 'Active', 'SIM'),
  ('00000000-0000-0000-0000-000000071403', 'claim-proj-waived-b', 'Waived', 'B', 'SF', ARRAY['SF'], 'Active', 'SIM');
INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via, acquisition_cost)
VALUES ('00000000-0000-0000-0000-000000071501', '00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071201', '00000000-0000-0000-0000-000000071401', 'free_agent', 0);
INSERT INTO public.waiver_wire_log (league_id, league_season_id, player_id, dropped_by_member_id, placed_on_waivers_at, clears_at) VALUES
  ('00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071402', NULL, now() - interval '3 days', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071403', NULL, now() - interval '3 days', now() + interval '1 hour');

-- Case A: full roster (1/1), claim with no drop, duplicate claim_order accepted at create time.
SELECT public.create_waiver_claim_atomic('00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071201', '00000000-0000-0000-0000-000000071402', NULL, '00000000-0000-0000-0000-000000071001', 0, 1);
-- Case B: claim whose drop player is the rostered player; the player is then dropped.
SELECT public.create_waiver_claim_atomic('00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071201', '00000000-0000-0000-0000-000000071403', '00000000-0000-0000-0000-000000071401', '00000000-0000-0000-0000-000000071001', 0, 1);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.waiver_claims WHERE member_id = '00000000-0000-0000-0000-000000071201' AND status = 'pending' AND claim_order = 1) <> 2 THEN
    RAISE EXCEPTION 'expected two pending claims sharing claim_order 1';
  END IF;
END $$;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000071001","role":"authenticated"}', true);
SELECT public.drop_player_atomic('00000000-0000-0000-0000-000000071501');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.roster_players WHERE id = '00000000-0000-0000-0000-000000071501') THEN RAISE EXCEPTION 'drop did not remove the player'; END IF;
  IF (SELECT count(*) FROM public.waiver_claims WHERE drop_player_id = '00000000-0000-0000-0000-000000071401' AND status = 'pending') <> 1 THEN
    RAISE EXCEPTION 'dropping the drop player did not leave the claim pending (no guard exists)';
  END IF;
END $$;

-- Processing once the holds clear and the process date arrives.
UPDATE public.waiver_wire_log SET clears_at = now() - interval '1 minute' WHERE league_id = '00000000-0000-0000-0000-000000071101';
UPDATE public.waiver_claims SET process_date = current_date - 1 WHERE league_id = '00000000-0000-0000-0000-000000071101';
CREATE TEMP TABLE projection_results AS
SELECT * FROM public.process_due_waiver_claims_atomic(current_date, 100);
DO $$
DECLARE v record; v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM projection_results;
  FOR v IN SELECT * FROM projection_results LOOP RAISE NOTICE 'claim % -> % (%)', v.player_id, v.status, v.failure_reason; END LOOP;
  IF v_rows <> 2 THEN RAISE EXCEPTION 'expected both claims to be processed, got % rows', v_rows; END IF;
  IF NOT EXISTS (SELECT 1 FROM projection_results WHERE player_id = '00000000-0000-0000-0000-000000071403' AND status = 'failed' AND failure_reason LIKE 'Drop player is no longer%') THEN
    RAISE EXCEPTION 'claim B did not fail with the drop-player-gone reason';
  END IF;
  -- Claim A: the roster now has room (the drop freed the only slot), so it is
  -- processed on its merits; either outcome is recorded, never an exception.
  IF NOT EXISTS (SELECT 1 FROM projection_results WHERE player_id = '00000000-0000-0000-0000-000000071402') THEN
    RAISE EXCEPTION 'claim A was not processed';
  END IF;
END $$;
ROLLBACK;
