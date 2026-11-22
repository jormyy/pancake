\set ON_ERROR_STOP off
\if :{?case_filter}
\else
\set case_filter all
\endif
SET app.case_filter = :'case_filter';
\ir rules-support.sql
SET LOCAL statement_timeout = '180s';
CREATE TEMP SEQUENCE r5r_case_1;
CREATE TEMP SEQUENCE r5r_case_2;
CREATE TEMP SEQUENCE r5r_case_3;
CREATE TEMP SEQUENCE r5r_case_4;
CREATE FUNCTION pg_temp.record_case(p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT nextval(%L)', 'pg_temp.r5r_case_' || p_name);
END;
$$;

CREATE FUNCTION pg_temp.r5r_league(p_year int, p_teams int, p_floor int, p_ir boolean, p_activate boolean)
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

CREATE FUNCTION pg_temp.r5r_player(p_league uuid, p_season uuid, p_member uuid, p_name text, p_injury text, p_return text)
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

CREATE FUNCTION pg_temp.r5r_free_agent(p_league uuid, p_season uuid, p_year int, p_name text, p_avg numeric, p_id uuid DEFAULT NULL)
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

CREATE FUNCTION pg_temp.r5r_roster(p_league uuid, p_season uuid, p_member uuid, p_count int)
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

CREATE FUNCTION pg_temp.r5r_fail_ir() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state text := current_setting('app.r5_fail_state', true);
BEGIN
  IF NEW.player_id = current_setting('app.r5_fail_player', true)::uuid THEN
    RAISE EXCEPTION 'injected IR move failure' USING ERRCODE = v_state;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER r5r_fail_ir BEFORE UPDATE ON public.roster_players
  FOR EACH ROW EXECUTE FUNCTION pg_temp.r5r_fail_ir();

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_injured uuid; v_state text; r jsonb;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '1') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5r_league(9851, 2, NULL, true, true);
  v_injured := pg_temp.r5r_player(f.league_id, f.season_id, f.member_ids[1], 'OutA', 'Out', (v_today + 14)::text);
  PERFORM pg_temp.r5r_player(f.league_id, f.season_id, f.member_ids[1], 'HealthyB', NULL, NULL);
  PERFORM set_config('app.r5_fail_player', v_injured::text, true);
  PERFORM set_config('app.r5_fail_state', '55P03', true);
  BEGIN
    r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.check_rules(v_state = '55P03', 'case 1: a transient IR move failure surfaces as a failure');
  PERFORM pg_temp.record_case('1');
  RAISE NOTICE 'PASS case-1';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_noon timestamptz := (v_today + time '12:00') AT TIME ZONE 'America/New_York';
  v_latch timestamptz; v_activated boolean;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '2') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5r_league(9852, 2, 16, true, false);
  DELETE FROM private.work_items;
  UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id <> f.league_id;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),
    'case 2: an all-manual league dispatches nothing before activation');
  PERFORM public.get_pending_auto_ir_members(v_today, p_include_enabled => true);
  SELECT ir_activated_at INTO v_latch FROM private.league_roster_policies WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_latch IS NULL, 'case 2: worker admission does not activate the policy');
  PERFORM pg_temp.check_rules(to_regprocedure('private.activate_league_roster_policy(uuid)') IS NOT NULL,
    'case 2: an explicit activation action exists');
  IF to_regprocedure('private.activate_league_roster_policy(uuid)') IS NOT NULL THEN
    v_activated := private.activate_league_roster_policy(f.league_id);
    PERFORM pg_temp.check_rules(v_activated, 'case 2: the explicit activation action accepts the league');
  END IF;
  DELETE FROM private.work_items;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),
    'case 2: activation starts the all-manual league');
  PERFORM pg_temp.record_case('2');
  RAISE NOTICE 'PASS case-2';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_awards int;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '3') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5r_league(9853, 2, 16, true, true);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  PERFORM pg_temp.r5r_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.r5r_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.r5r_free_agent(f.league_id, f.season_id, 9853, 'FA', 40);
  INSERT INTO private.screen_average_dirty(league_season_id, player_id)
    SELECT f.season_id, player_id FROM public.player_season_averages WHERE league_id=f.league_id;
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'averages_pending', 'case 3: a delayed average refresh defers the floor');
  PERFORM pg_temp.check_rules(v_awards = 0, 'case 3: a delayed average refresh awards nobody');
  PERFORM pg_temp.record_case('3');
  RAISE NOTICE 'PASS case-3';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '110 seconds';
  v_item private.work_items%ROWTYPE; v_key uuid := gen_random_uuid(); v_state text;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '4') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r5r_league(9854, 2, NULL, false, false);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029854001', 9854, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  PERFORM private.work_enqueue('pre-tipoff', v_tipoff::text || ':r5', now(),
    jsonb_build_object('mode','pre_tipoff','tipoffAt',v_tipoff,'fingerprint','r5'));
  SELECT * INTO v_item FROM private.work_claim();
  PERFORM pg_temp.check_rules(v_item.lease_until > now() + interval '200 seconds',
    'case 4: a non-policy tipoff keeps the base five-minute lease');
  UPDATE private.work_items SET invocation_key = v_key, lease_until = now() + interval '250 seconds' WHERE id = v_item.id;
  INSERT INTO public.edge_invocations(function_name, invocation_key, work_item_id, work_lease_token, queued_at)
    VALUES('lineup-optimizer', v_key, v_item.id, v_item.lease_token, now());
  BEGIN
    PERFORM public.start_work_invocation(v_key, 'lineup-optimizer');
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.check_rules(v_state IS NULL, 'case 4: a non-policy invocation starting fifty seconds late is admitted');
  PERFORM pg_temp.record_case('4');
  RAISE NOTICE 'PASS case-4';
END;
$$;
ROLLBACK;

\set ON_ERROR_STOP on
DO $$
DECLARE v_missing text; v_name text; v_called boolean;
BEGIN
  FOR v_name IN SELECT unnest(ARRAY['1','2','3','4']) LOOP
    IF current_setting('app.case_filter', true) NOT IN ('all', v_name) THEN CONTINUE; END IF;
    EXECUTE format('SELECT is_called FROM pg_temp.r5r_case_%s', v_name) INTO v_called;
    IF NOT v_called THEN v_missing := COALESCE(v_missing || ', ', '') || v_name; END IF;
  END LOOP;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'cases did not run: %', v_missing; END IF;
END;
$$;
