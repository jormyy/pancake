\set ON_ERROR_STOP off
\if :{?mode}
\else
\set mode green
\endif
\if :{?case_filter}
\else
\set case_filter all
\endif
SET app.mode = :'mode';
SET app.case_filter = :'case_filter';
\ir rules-support.sql
SET LOCAL statement_timeout = '180s';
CREATE TEMP SEQUENCE r5_case_1a;
CREATE TEMP SEQUENCE r5_case_1b;
CREATE TEMP SEQUENCE r5_case_1c;
CREATE TEMP SEQUENCE r5_case_2;
CREATE TEMP SEQUENCE r5_case_3a;
CREATE TEMP SEQUENCE r5_case_3b;
CREATE TEMP SEQUENCE r5_case_3c;
CREATE TEMP SEQUENCE r5_case_3d;
CREATE TEMP SEQUENCE r5_case_4a;
CREATE TEMP SEQUENCE r5_case_4b;
CREATE TEMP SEQUENCE r5_case_4c;
CREATE FUNCTION pg_temp.record_case(p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT nextval(%L)', 'pg_temp.r5_case_' || p_name);
END;
$$;

CREATE FUNCTION pg_temp.r5_league(p_year int, p_teams int, p_floor int, p_ir boolean, p_activate boolean)
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], user_ids uuid[], week_end date)
LANGUAGE plpgsql AS $$
DECLARE f record; v_end date := (now() AT TIME ZONE 'America/New_York')::date; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=20, ir_slots=1, timezone='Pacific/Kiritimati' WHERE id=f.league_id;
  UPDATE public.lineup_optimizer_settings s SET enabled=false, enabled_at=NULL WHERE s.league_id=f.league_id;
  IF p_floor IS NOT NULL OR p_ir THEN
    INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
      VALUES(f.league_id, p_floor, p_ir, CASE WHEN p_activate THEN now() END, CASE WHEN p_activate THEN now() END);
  END IF;
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
    SELECT f.league_id, f.season_id, true, league.scoring_settings
      FROM public.leagues league WHERE league.id = f.league_id
    ON CONFLICT (league_season_id) DO UPDATE
      SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(p_year, 1, v_end - 6, v_end)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
  UPDATE public.nba_games SET status='Final', game_time=now() - interval '1 hour' WHERE game_date IN (v_end - 1, v_end);
  FOR i IN 1..(p_teams / 2) LOOP
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
      VALUES(f.league_id, f.season_id, 1, f.member_ids[i * 2 - 1], f.member_ids[i * 2]);
  END LOOP;
  league_id := f.league_id; season_id := f.season_id; member_ids := f.member_ids; user_ids := f.user_ids; week_end := v_end;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pg_temp.r5_player(p_league uuid, p_season uuid, p_member uuid, p_name text, p_injury text, p_return text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(v_player, v_player::text, p_name, 'Test', 'PG', ARRAY['PG'], p_injury, COALESCE(p_return, 'unknown'), 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(p_league, p_season, p_member, v_player, 'draft');
  RETURN v_player;
END;
$$;

CREATE FUNCTION pg_temp.r5_free_agent(p_league uuid, p_season uuid, p_year int, p_name text, p_avg numeric, p_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, v_player::text, p_name, 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
  INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
    VALUES(p_league, p_season, p_year, v_player, '{}'::jsonb, p_avg, 1);
  RETURN v_player;
END;
$$;

CREATE FUNCTION pg_temp.r5_roster(p_league uuid, p_season uuid, p_member uuid, p_count int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int; v_player uuid;
BEGIN
  FOR i IN 1..p_count LOOP
    v_player := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_player, v_player::text, 'Roster' || i, 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES(p_league, p_season, p_member, v_player, 'draft');
  END LOOP;
END;
$$;

CREATE FUNCTION pg_temp.r5_fail_ir() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text := current_setting('app.r5_fail_state', true);
BEGIN
  IF NEW.player_id = current_setting('app.r5_fail_player', true)::uuid THEN
    RAISE EXCEPTION 'injected IR move failure' USING ERRCODE = v_state;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER r5_fail_ir BEFORE UPDATE ON public.roster_players
  FOR EACH ROW EXECUTE FUNCTION pg_temp.r5_fail_ir();

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_injured uuid; v_state text; v_message text; r jsonb;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '1a') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9951, 2, NULL, true, true);
  v_injured := pg_temp.r5_player(f.league_id, f.season_id, f.member_ids[1], 'OutA', 'Out', (v_today + 14)::text);
  PERFORM pg_temp.r5_player(f.league_id, f.season_id, f.member_ids[1], 'HealthyB', NULL, NULL);
  PERFORM set_config('app.r5_fail_player', v_injured::text, true);
  PERFORM set_config('app.r5_fail_state', '55P03', true);
  BEGIN
    r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_message := SQLERRM;
  END;
  PERFORM pg_temp.check_rules(v_state = '55P03', 'case 1a: a transient move failure raises its SQLSTATE');
  PERFORM pg_temp.check_rules(v_message LIKE '%transiently%', 'case 1a: the transient failure is named');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM public.roster_players
    WHERE league_id=f.league_id AND member_id=f.member_ids[1] AND player_id=v_injured),
    'case 1a: the failed pass commits no partial IR move');
  PERFORM pg_temp.record_case('1a');
  RAISE NOTICE 'PASS case-1a';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_injured uuid; v_state text; r jsonb;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '1b') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9952, 2, NULL, false, false);
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(f.league_id, f.season_id, f.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled=true, enabled_at=now();
  v_injured := pg_temp.r5_player(f.league_id, f.season_id, f.member_ids[1], 'OutA', 'Out', (v_today + 14)::text);
  PERFORM pg_temp.r5_player(f.league_id, f.season_id, f.member_ids[1], 'HealthyB', NULL, NULL);
  PERFORM set_config('app.r5_fail_player', v_injured::text, true);
  PERFORM set_config('app.r5_fail_state', '55P03', true);
  BEGIN
    r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.check_rules(v_state IS NULL, 'case 1b: a league without the policy keeps base skip behavior');
  PERFORM pg_temp.check_rules(r->'skipped' @> jsonb_build_array(jsonb_build_object('playerId', v_injured::text)),
    'case 1b: the base skip is still reported');
  PERFORM pg_temp.record_case('1b');
  RAISE NOTICE 'PASS case-1b';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_injured uuid; v_state text; r jsonb;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '1c') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9953, 2, NULL, true, true);
  v_injured := pg_temp.r5_player(f.league_id, f.season_id, f.member_ids[1], 'OutA', 'Out', (v_today + 14)::text);
  PERFORM pg_temp.r5_player(f.league_id, f.season_id, f.member_ids[1], 'HealthyB', NULL, NULL);
  PERFORM set_config('app.r5_fail_player', v_injured::text, true);
  PERFORM set_config('app.r5_fail_state', 'P0001', true);
  BEGIN
    r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.check_rules(v_state IS NULL, 'case 1c: an ordinary move failure does not raise');
  PERFORM pg_temp.check_rules(r->'skipped' @> jsonb_build_array(jsonb_build_object('playerId', v_injured::text, 'sqlstate', 'P0001')),
    'case 1c: the ordinary skip carries its SQLSTATE');
  PERFORM pg_temp.record_case('1c');
  RAISE NOTICE 'PASS case-1c';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; c record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_noon timestamptz := (v_today + time '12:00') AT TIME ZONE 'America/New_York';
  v_tipoff timestamptz := now() + interval '90 seconds';
  v_latch timestamptz;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '2') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9954, 2, 16, true, false);
  SELECT * INTO c FROM pg_temp.r5_league(9955, 1, NULL, false, false);
  DELETE FROM private.work_items;
  UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id <> f.league_id;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),
    'case 2: an all-manual league dispatches no off-day run before activation');
  PERFORM public.get_pending_auto_ir_members(v_today, p_include_enabled => true);
  SELECT ir_activated_at INTO v_latch FROM private.league_roster_policies WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_latch IS NULL, 'case 2: worker admission does not activate the policy');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029954001', 9954, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind IN ('pre-tipoff','pre-tipoff-policy')),
    'case 2: an all-manual league dispatches no tipoff work before activation');
  PERFORM private.activate_league_roster_policy(f.league_id);
  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=f.league_id::text),
    'case 2: explicit activation admits the tipoff run');
  UPDATE public.nba_games SET status='Final', game_time=now() - interval '1 hour' WHERE nba_game_id='0029954001';
  DELETE FROM private.work_items;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),
    'case 2: explicit activation admits the off-day daily run');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM public.get_pending_auto_ir_members(v_today, p_include_enabled => true)) = 2,
    'case 2: both all-manual teams are admitted after activation');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_pending_auto_ir_members(v_today, p_include_enabled => true) WHERE league_id=c.league_id),
    'case 2: the control league stays out');
  UPDATE private.league_roster_policies SET floor_activated_at=NULL, ir_activated_at=NULL WHERE league_id=f.league_id;
  DELETE FROM private.work_items;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),
    'case 2: the documented rollback returns to base dispatch');
  PERFORM pg_temp.record_case('2');
  RAISE NOTICE 'PASS case-2';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_awards int;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '3a') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9956, 2, 16, true, true);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.r5_free_agent(f.league_id, f.season_id, 9956, 'FA', 40);
  UPDATE public.leagues SET scoring_settings = jsonb_build_object('points', 2) WHERE id=f.league_id;
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'averages_pending', 'case 3a: a scoring change defers the floor');
  PERFORM pg_temp.check_rules(v_awards = 0, 'case 3a: a scoring change awards nobody');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_weeks WHERE league_id=f.league_id AND status='completed'),
    'case 3a: a scoring change does not complete the week');
  PERFORM pg_temp.record_case('3a');
  RAISE NOTICE 'PASS case-3a';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_a uuid; v_b uuid; v_awarded uuid;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '3b') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9957, 2, 16, true, true);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_a := pg_temp.r5_free_agent(f.league_id, f.season_id, 9957, 'Alpha', 40);
  v_b := pg_temp.r5_free_agent(f.league_id, f.season_id, 9957, 'Bravo', 30);
  INSERT INTO private.screen_average_dirty(league_season_id, player_id) VALUES(f.season_id, v_a), (f.season_id, v_b);
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'averages_pending', 'case 3b: a delayed average refresh defers the floor');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id=f.league_id),
    'case 3b: a delayed average refresh awards nobody');
  UPDATE public.player_season_averages SET avg_fantasy_points = 20 WHERE league_id=f.league_id AND player_id=v_a;
  UPDATE public.player_season_averages SET avg_fantasy_points = 50 WHERE league_id=f.league_id AND player_id=v_b;
  DELETE FROM private.screen_average_dirty WHERE league_season_id=f.season_id;
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  SELECT player_id INTO v_awarded FROM private.roster_floor_awards WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed', 'case 3b: the refreshed floor completes');
  PERFORM pg_temp.check_rules(v_awarded = v_b, 'case 3b: the corrected ranking awards the new leader');
  PERFORM pg_temp.record_case('3b');
  RAISE NOTICE 'PASS case-3b';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '3c') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9958, 2, 16, true, true);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.r5_free_agent(f.league_id, f.season_id, 9958, 'FA', 40);
  UPDATE private.screen_refresh_queue SET averages_initialized = false WHERE league_season_id = f.season_id;
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'averages_pending', 'case 3c: an uninitialized cache defers the floor');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id=f.league_id),
    'case 3c: an uninitialized cache awards nobody');
  DELETE FROM private.screen_refresh_queue WHERE league_season_id = f.season_id;
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'averages_pending', 'case 3c: a missing cache row defers the floor');
  PERFORM pg_temp.record_case('3c');
  RAISE NOTICE 'PASS case-3c';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_a uuid; v_b uuid; v_awarded uuid;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '3d') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9959, 2, 16, true, true);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.r5_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_a := pg_temp.r5_free_agent(f.league_id, f.season_id, 9959, 'TieA', 30, '00000000-0000-0000-0000-0000000000aa');
  v_b := pg_temp.r5_free_agent(f.league_id, f.season_id, 9959, 'TieB', 30, '00000000-0000-0000-0000-0000000000bb');
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  SELECT player_id INTO v_awarded FROM private.roster_floor_awards WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed', 'case 3d: a tie still completes the floor');
  PERFORM pg_temp.check_rules(v_awarded = v_a, 'case 3d: a tie breaks on the lower player id');
  PERFORM pg_temp.record_case('3d');
  RAISE NOTICE 'PASS case-3d';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; c record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '110 seconds';
  v_item private.work_items%ROWTYPE; v_key uuid := gen_random_uuid(); v_run uuid;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '4a') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9960, 2, NULL, false, false);
  SELECT * INTO c FROM pg_temp.r5_league(9961, 1, NULL, false, false);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029960001', 9960, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  PERFORM private.work_enqueue('pre-tipoff', v_tipoff::text || ':r5', now(),
    jsonb_build_object('mode','pre_tipoff','tipoffAt',v_tipoff,'fingerprint','r5'));
  SELECT * INTO v_item FROM private.work_claim();
  PERFORM pg_temp.check_rules(v_item.lease_until > now() + interval '200 seconds',
    'case 4a: a non-policy tipoff keeps the base five-minute lease');
  UPDATE private.work_items SET invocation_key = v_key, lease_until = now() + interval '250 seconds' WHERE id = v_item.id;
  INSERT INTO public.edge_invocations(function_name, invocation_key, work_item_id, work_lease_token, queued_at)
    VALUES('lineup-optimizer', v_key, v_item.id, v_item.lease_token, now());
  v_run := public.start_work_invocation(v_key, 'lineup-optimizer');
  PERFORM pg_temp.check_rules(v_run IS NOT NULL, 'case 4a: a non-policy invocation starting fifty seconds late is admitted');
  PERFORM pg_temp.check_rules((SELECT lease_until FROM private.work_items WHERE id = v_item.id) > now() + interval '200 seconds',
    'case 4a: the late start keeps the base lease');
  PERFORM pg_temp.record_case('4a');
  RAISE NOTICE 'PASS case-4a';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '110 seconds';
  v_item private.work_items%ROWTYPE; v_item2 private.work_items%ROWTYPE;
  v_key uuid := gen_random_uuid(); v_state text;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '4b') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9962, 2, NULL, true, true);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029962001', 9962, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  PERFORM private.work_enqueue('pre-tipoff-policy', v_tipoff::text || ':' || f.league_id::text || ':r5', now(),
    jsonb_build_object('mode','pre_tipoff','tipoffAt',v_tipoff,'leagueId',f.league_id,'fingerprint','r5'));
  SELECT * INTO v_item FROM private.work_claim();
  PERFORM pg_temp.check_rules(v_item.lease_until <= now() + interval '60 seconds',
    'case 4b: policy tipoff work keeps the fast recovery lease');
  UPDATE private.work_items SET invocation_key = v_key, lease_until = now() - interval '5 seconds' WHERE id = v_item.id;
  INSERT INTO public.edge_invocations(function_name, invocation_key, work_item_id, work_lease_token, queued_at)
    VALUES('lineup-optimizer', v_key, v_item.id, v_item.lease_token, now());
  BEGIN
    PERFORM public.start_work_invocation(v_key, 'lineup-optimizer');
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.check_rules(v_state = 'PT409', 'case 4b: a policy invocation starting fifty seconds late is fenced');
  UPDATE private.work_items SET lease_until = now() - interval '1 second' WHERE id = v_item.id;
  PERFORM private.work_claim(0);
  UPDATE private.work_items SET due_at = now() WHERE id = v_item.id;
  SELECT * INTO v_item2 FROM private.work_claim();
  PERFORM pg_temp.check_rules(v_item2.id = v_item.id AND v_item2.lease_token <> v_item.lease_token,
    'case 4b: a replacement recovers the abandoned policy claim');
  PERFORM pg_temp.check_rules(v_tipoff > now(), 'case 4b: the replacement runs before the lock');
  PERFORM pg_temp.record_case('4b');
  RAISE NOTICE 'PASS case-4b';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; c record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '110 seconds';
  v_item private.work_items%ROWTYPE;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '4c') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5_league(9963, 2, NULL, true, false);
  SELECT * INTO c FROM pg_temp.r5_league(9964, 1, NULL, false, false);
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(c.league_id, c.season_id, c.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled=true, enabled_at=now();
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029963001', 9963, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  PERFORM private.work_enqueue('pre-tipoff', v_tipoff::text || ':r5', now(),
    jsonb_build_object('mode','pre_tipoff','tipoffAt',v_tipoff,'fingerprint','r5'));
  SELECT * INTO v_item FROM private.work_claim();
  PERFORM pg_temp.check_rules(v_item.lease_until > now() + interval '200 seconds',
    'case 4c: an inactive policy league sharing the tipoff keeps the base lease');
  PERFORM pg_temp.record_case('4c');
  RAISE NOTICE 'PASS case-4c';
END;
$$;
ROLLBACK;

\set ON_ERROR_STOP on
DO $$
DECLARE v_missing text; v_name text; v_called boolean;
BEGIN
  FOR v_name IN SELECT unnest(ARRAY['1a','1b','1c','2','3a','3b','3c','3d','4a','4b','4c']) LOOP
    IF current_setting('app.case_filter', true) NOT IN ('all', v_name) THEN CONTINUE; END IF;
    EXECUTE format('SELECT is_called FROM pg_temp.r5_case_%s', v_name) INTO v_called;
    IF NOT v_called THEN v_missing := COALESCE(v_missing || ', ', '') || v_name; END IF;
  END LOOP;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'cases did not run: %', v_missing; END IF;
END;
$$;
