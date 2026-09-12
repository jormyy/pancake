\set ON_ERROR_STOP off
-- shared synthetic fixture (rolled back at the end of each section)
\set uid '00000000-0000-0000-0000-000000070001'
\set lid '00000000-0000-0000-0000-000000070101'
\set mid '00000000-0000-0000-0000-000000070201'
\set sid '00000000-0000-0000-0000-000000070301'
\set p1 '00000000-0000-0000-0000-000000070401'
\set p2 '00000000-0000-0000-0000-000000070402'
\set p3 '00000000-0000-0000-0000-000000070403'
\set p4 '00000000-0000-0000-0000-000000070404'

\echo ==== P5 roster#8 claim ordering/projection at create time
BEGIN;
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES (:'uid', 'authenticated', 'authenticated', 'probe-roster@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, username, display_name) VALUES (:'uid', 'probe_roster', 'Probe Roster') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit, roster_size)
VALUES (:'lid', 'Probe Roster League', 'probe-roster-league', :'uid', 'active', 'rolling', NULL, 1);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name) VALUES (:'mid', :'lid', :'uid', 'commissioner', 'Probe');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current) VALUES (:'sid', :'lid', 2097, true);
INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority) VALUES (:'lid', :'sid', :'mid', 1);
INSERT INTO public.players (id, sportsdata_id, first_name, last_name, position, eligible_positions, status, nba_team) VALUES
 (:'p1', 'probe-rostered', 'Rostered', 'One', 'PG', ARRAY['PG'], 'Active', 'SIM'),
 (:'p2', 'probe-waived-a', 'Waived', 'A', 'SG', ARRAY['SG'], 'Active', 'SIM'),
 (:'p3', 'probe-waived-b', 'Waived', 'B', 'SF', ARRAY['SF'], 'Active', 'SIM'),
 (:'p4', 'probe-fa', 'Free', 'Agent', 'C', ARRAY['C'], 'Active', 'SIM');
INSERT INTO public.roster_players (league_id, league_season_id, member_id, player_id, acquired_via, acquisition_cost)
VALUES (:'lid', :'sid', :'mid', :'p1', 'free_agent', 0);
INSERT INTO public.waiver_wire_log (league_id, league_season_id, player_id, clears_at) VALUES
 (:'lid', :'sid', :'p2', now() - interval '1 hour'), (:'lid', :'sid', :'p3', now() - interval '1 hour');
-- roster is full (1/1): claims with no drop and with duplicate claim_order
SELECT 'claim A (no drop, roster full, order 1)' AS step, public.create_waiver_claim_atomic(:'lid', :'mid', :'p2', NULL, :'uid', 0, 1) IS NOT NULL AS accepted;
SELECT 'claim B (no drop, roster full, order 1 again)' AS step, public.create_waiver_claim_atomic(:'lid', :'mid', :'p3', NULL, :'uid', 0, 1) IS NOT NULL AS accepted;
SELECT player_id = :'p2' AS is_a, claim_order, drop_player_id IS NULL AS no_drop, status FROM public.waiver_claims WHERE member_id = :'mid' ORDER BY player_id;
SELECT processed, status, left(failure_reason, 70) AS reason FROM public.process_due_waiver_claims_atomic(current_date + 2, 100) ORDER BY 2;
ROLLBACK;

\echo ==== P6 roster#3 dropping the player a pending claim names as its drop
BEGIN;
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES (:'uid', 'authenticated', 'authenticated', 'probe-roster@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, username, display_name) VALUES (:'uid', 'probe_roster', 'Probe Roster') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit, roster_size)
VALUES (:'lid', 'Probe Roster League', 'probe-roster-league', :'uid', 'active', 'rolling', NULL, 5);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name) VALUES (:'mid', :'lid', :'uid', 'commissioner', 'Probe');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current) VALUES (:'sid', :'lid', 2097, true);
INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority) VALUES (:'lid', :'sid', :'mid', 1);
INSERT INTO public.players (id, sportsdata_id, first_name, last_name, position, eligible_positions, status, nba_team) VALUES
 (:'p1', 'probe-rostered', 'Rostered', 'One', 'PG', ARRAY['PG'], 'Active', 'SIM'),
 (:'p2', 'probe-waived-a', 'Waived', 'A', 'SG', ARRAY['SG'], 'Active', 'SIM');
INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via, acquisition_cost)
VALUES ('00000000-0000-0000-0000-000000070501', :'lid', :'sid', :'mid', :'p1', 'free_agent', 0);
INSERT INTO public.waiver_wire_log (league_id, league_season_id, player_id, clears_at) VALUES (:'lid', :'sid', :'p2', now() - interval '1 hour');
SELECT 'claim with drop = rostered player' AS step, public.create_waiver_claim_atomic(:'lid', :'mid', :'p2', :'p1', :'uid', 0, 1) IS NOT NULL AS accepted;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'uid', 'role', 'authenticated')::text, true) IS NOT NULL AS jwt_set;
SELECT 'drop_player_atomic on that player' AS step; SELECT public.drop_player_atomic('00000000-0000-0000-0000-000000070501');
SELECT count(*) AS still_rostered FROM public.roster_players WHERE id = '00000000-0000-0000-0000-000000070501';
SELECT count(*) AS claims_still_pending FROM public.waiver_claims WHERE member_id = :'mid' AND status = 'pending';
SELECT 'processing after the drop:' AS note, processed, status, left(failure_reason, 70) AS reason FROM public.process_due_waiver_claims_atomic(current_date + 2, 100);
ROLLBACK;

\echo ==== P7 roster#1 toggle_ir_atomic has no lineup-lock check (team already tipped today)
BEGIN;
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES (:'uid', 'authenticated', 'authenticated', 'probe-roster@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, username, display_name) VALUES (:'uid', 'probe_roster', 'Probe Roster') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit, roster_size, ir_slots)
VALUES (:'lid', 'Probe Roster League', 'probe-roster-league', :'uid', 'active', 'rolling', NULL, 5, 2);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name) VALUES (:'mid', :'lid', :'uid', 'commissioner', 'Probe');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current) VALUES (:'sid', :'lid', 2026, true);
INSERT INTO public.players (id, sportsdata_id, first_name, last_name, position, eligible_positions, status, nba_team, injury_status) VALUES
 (:'p1', 'probe-injured', 'Injured', 'One', 'PG', ARRAY['PG'], 'Active', 'BOS', 'Out');
INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via, acquisition_cost, is_on_ir)
VALUES ('00000000-0000-0000-0000-000000070501', :'lid', :'sid', :'mid', :'p1', 'free_agent', 0, true);
INSERT INTO public.nba_games (id, season_year, game_date, week_number, home_team, away_team, status, game_time)
VALUES ('00000000-0000-4000-8000-0000000000f3', 2026, (timezone('America/New_York', now()))::date, 1, 'BOS', 'MIA', 'InProgress', now() - interval '30 minutes');
SELECT 'edge-only lock check functions in DB:' AS note, count(*) AS db_functions_checking_game_status FROM pg_proc WHERE proname IN ('toggle_ir_atomic','toggle_taxi_atomic','activate_roster_player_with_overflow_atomic') AND prosrc ILIKE '%InProgress%';
SELECT 'toggle_ir_atomic(IR -> active) during a live game' AS step; SELECT public.toggle_ir_atomic('00000000-0000-0000-0000-000000070501', false, :'uid');
SELECT is_on_ir FROM public.roster_players WHERE id = '00000000-0000-0000-0000-000000070501';
ROLLBACK;
