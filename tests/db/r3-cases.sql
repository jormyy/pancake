\set ON_ERROR_STOP off
\if :{?mode}
\else
\set mode green
\endif
SET app.mode = :'mode';
\ir rules-support.sql
CREATE TEMP SEQUENCE r3_case_1;
CREATE TEMP SEQUENCE r3_case_1b;
CREATE TEMP SEQUENCE r3_case_2;
CREATE TEMP SEQUENCE r3_case_3;
CREATE TEMP SEQUENCE r3_case_4;
CREATE TEMP SEQUENCE r3_case_6;
CREATE TEMP SEQUENCE r3_case_7;
CREATE TEMP SEQUENCE r3_case_8;
CREATE TEMP SEQUENCE r3_case_A;
CREATE TEMP SEQUENCE r3_case_B;
CREATE TEMP SEQUENCE r3_case_C;
CREATE TEMP SEQUENCE r3_case_control;
CREATE FUNCTION pg_temp.record_case(p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT nextval(%L)', 'pg_temp.r3_case_' || p_name);
END;
$$;

CREATE FUNCTION pg_temp.floor_roster(p_league uuid, p_season uuid, p_member uuid, p_count int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int; v_player uuid;
BEGIN
  FOR i IN 1..p_count LOOP
    v_player := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_player, v_player::text, 'Roster', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES(p_league, p_season, p_member, v_player, 'draft');
  END LOOP;
END;
$$;

CREATE FUNCTION pg_temp.floor_free_agent(p_league uuid, p_season uuid, p_year int, p_name text, p_avg numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, v_player::text, p_name, 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
  INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
    VALUES(p_league, p_season, p_year, v_player, '{}'::jsonb, p_avg, 1);
  RETURN v_player;
END;
$$;

CREATE FUNCTION pg_temp.floor_league(p_year int, p_teams int, p_floor int, p_ir boolean)
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], user_ids uuid[], week_end date)
LANGUAGE plpgsql AS $$
DECLARE f record; v_end date := (now() AT TIME ZONE 'America/New_York')::date; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=20, ir_slots=1, timezone='Pacific/Kiritimati' WHERE id=f.league_id;
  UPDATE public.lineup_optimizer_settings s SET enabled=false, enabled_at=NULL WHERE s.league_id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members)
    VALUES(f.league_id, p_floor, true);
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='private' AND table_name='league_roster_policies' AND column_name='ir_activated_at') THEN
    UPDATE private.league_roster_policies SET floor_activated_at=now(), ir_activated_at=CASE WHEN p_ir THEN now() ELSE NULL END WHERE private.league_roster_policies.league_id=f.league_id;
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='private' AND table_name='league_roster_policies' AND column_name='worker_activated_at') THEN
    UPDATE private.league_roster_policies SET worker_activated_at=now() WHERE private.league_roster_policies.league_id=f.league_id;
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

CREATE FUNCTION pg_temp.floor_missed_week(p_year int, p_teams int, p_floor int, p_policy boolean)
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], week1_end date, week2_end date)
LANGUAGE plpgsql AS $$
DECLARE f record; v_end date := (now() AT TIME ZONE 'America/New_York')::date; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=20, ir_slots=1, timezone='Pacific/Tongatapu' WHERE id=f.league_id;
  UPDATE public.lineup_optimizer_settings s SET enabled=false, enabled_at=NULL WHERE s.league_id=f.league_id;
  IF p_policy THEN
    INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
      VALUES(f.league_id, p_floor, true, now(), now());
  END IF;
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
    SELECT f.league_id, f.season_id, true, league.scoring_settings
      FROM public.leagues league WHERE league.id = f.league_id
    ON CONFLICT (league_season_id) DO UPDATE
      SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(p_year, 1, v_end - 13, v_end - 7),
          (p_year, 2, v_end - 6, v_end)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key
    DO UPDATE SET week_start=EXCLUDED.week_start, week_end=EXCLUDED.week_end;
  UPDATE public.nba_games SET status='Final', game_time=now() - interval '1 hour' WHERE game_date IN (v_end - 1, v_end);
  FOR i IN 1..(p_teams / 2) LOOP
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
      VALUES(f.league_id, f.season_id, 1, f.member_ids[i * 2 - 1], f.member_ids[i * 2]);
  END LOOP;
  league_id := f.league_id; season_id := f.season_id; member_ids := f.member_ids;
  week1_end := v_end - 7; week2_end := v_end;
  RETURN NEXT;
END;
$$;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_active int; v_ir uuid; v_fa uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9910, 2, 16, true);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_ir := pg_temp.floor_free_agent(f.league_id, f.season_id, 9910, 'IR', 40);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_ir, 'draft', true);
  v_fa := pg_temp.floor_free_agent(f.league_id, f.season_id, 9910, 'FA', 30);
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT count(*) INTO v_active FROM public.roster_players WHERE league_id=f.league_id AND member_id=f.member_ids[1] AND NOT is_on_ir AND NOT is_on_taxi;
  PERFORM pg_temp.check_rules(v_active = 16, 'case 1: healthy IR return reaches 16');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM private.roster_floor_awards WHERE league_id=f.league_id AND player_id=v_fa), 'case 1: no free-agent award');
  PERFORM pg_temp.record_case('1');
  RAISE NOTICE 'PASS case-1';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_awards int;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9911, 2, 16, false);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_free_agent(f.league_id, f.season_id, 9911, 'FA', 30);
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_awards = 0, 'case 1b: no award with IR latch NULL');
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'ir_pending', 'case 1b: reason ir_pending');
  PERFORM pg_temp.record_case('1b');
  RAISE NOTICE 'PASS case-1b';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_count int; v_awards int;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9912, 2, 16, true);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_free_agent(f.league_id, f.season_id, 9912, 'FA', 30);
  v_count := public.settle_latest_waiver_runs((f.week_end + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=f.week_end) = 1, 'case 2: Sunday settles once');
  v_count := public.settle_latest_waiver_runs((f.week_end + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=f.week_end) = 1, 'case 2: retry is idempotent');
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_awards = 1, 'case 2: floor runs once');
  PERFORM pg_temp.record_case('2');
  RAISE NOTICE 'PASS case-2';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_old text; v_after text; v_player uuid; v_today date := (now() AT TIME ZONE 'America/New_York')::date; v_tipoff timestamptz := now() + interval '1 minute';
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9923, 2, 16, true);
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(f.league_id, f.season_id, f.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled=true, enabled_at=now();
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029923001', 9923, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  v_player := pg_temp.floor_free_agent(f.league_id, f.season_id, 9923, 'Late', 40);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[2], v_player, 'draft');
  v_old := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until, input_fingerprint)
    VALUES(v_tipoff, f.league_id::text, v_today, gen_random_uuid(), 'succeeded', now(), v_old);
  INSERT INTO private.work_items(kind, key, due_at, payload, status)
    VALUES('pre-tipoff-policy', v_tipoff::text||':'||f.league_id::text||':'||v_old, now(), jsonb_build_object('mode','pre_tipoff','tipoffAt',v_tipoff,'leagueId',f.league_id,'fingerprint',v_old), 'succeeded');
  UPDATE public.players SET injury_status='Out', injury_expected_return=(v_today + 14)::text WHERE id=v_player;
  v_after := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  PERFORM pg_temp.check_rules(v_after IS DISTINCT FROM v_old, 'case 3: manual Out changes the fingerprint');
  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND status='pending' AND payload->>'leagueId'=f.league_id::text), 'case 3: scheduler enqueues a new pass');
  PERFORM pg_temp.record_case('3');
  RAISE NOTICE 'PASS case-3';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_auto boolean; v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9924, 2, 16, false);
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(f.league_id, f.season_id, f.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled=true, enabled_at=now();
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
    VALUES(now() + interval '10 minutes', f.league_id::text, f.week_end, v_token, 'running', now() + interval '1 minute');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029924001', 9924, 1, f.week_end, 'ZZ', 'ZY', 'Scheduled', now() + interval '10 minutes');
  PERFORM private.activate_league_roster_policy(f.league_id);
  SELECT auto_ir INTO v_auto FROM public.get_pending_tipoff_members(now() + interval '10 minutes', v_token, ARRAY[]::uuid[], 100, f.league_id::text) WHERE member_id=f.member_ids[1];
  PERFORM pg_temp.check_rules(v_auto, 'case 4: activation makes auto_ir true');
  PERFORM pg_temp.record_case('4');
  RAISE NOTICE 'PASS case-4';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_awards int; v_status text; v_zone text; v_local date;
  v_et date := (now() AT TIME ZONE 'America/New_York')::date; v_work int;
BEGIN
  SELECT name INTO v_zone FROM pg_timezone_names
   WHERE (now() AT TIME ZONE name)::date > v_et
   ORDER BY (now() AT TIME ZONE name)::date DESC, name LIMIT 1;
  IF v_zone IS NULL THEN v_zone := 'Pacific/Kiritimati'; END IF;
  v_local := (now() AT TIME ZONE v_zone)::date;
  RAISE NOTICE 'case-6 clock zone=% et=% local=%', v_zone, v_et, v_local;
  SELECT * INTO f FROM pg_temp.floor_league(9926, 2, 16, true);
  UPDATE public.leagues SET timezone=v_zone WHERE id=f.league_id;
  DELETE FROM private.waiver_run_settlements WHERE league_id=f.league_id;
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_free_agent(f.league_id, f.season_id, 9926, 'FA', 30);
  PERFORM pg_temp.check_rules((f.week_end + time '00:00') AT TIME ZONE v_zone <= now(), 'case 6: the database clock passed the league midnight');
  PERFORM pg_temp.check_rules(v_local >= f.week_end, 'case 6: the league-local date reached the settlement date');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.roster_floor_awards WHERE league_id=f.league_id) = 0, 'case 6: no award before settlement');
  PERFORM public.settle_latest_waiver_runs(now());
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=f.week_end) = 1, 'case 6: the database clock settles the week');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work(date_trunc('hour', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York');
  SELECT count(*) INTO v_work FROM private.work_items WHERE kind='roster-floor' AND league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_work = 1, 'case 6: the scheduler admits the floor after the league midnight');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=f.league_id;
  SELECT status INTO v_status FROM private.roster_floor_weeks WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_awards = 1, 'case 6: the floor completes once after the league midnight');
  PERFORM pg_temp.check_rules(v_status = 'completed', 'case 6: week completed');
  PERFORM pg_temp.record_case('6');
  RAISE NOTICE 'PASS case-6';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_token uuid := gen_random_uuid(); v_tipoff timestamptz := now() + interval '10 minutes';
  v_notices_before jsonb; v_auto_before boolean; v_floor_before jsonb; v_work_before int;
  v_notices_after jsonb; v_auto_after boolean; v_floor_after jsonb; v_work_after int;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9927, 2, 16, true);
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(f.league_id, f.season_id, f.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled=true, enabled_at=now();
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029927001', 9927, 1, f.week_end, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, game_date, token, status, lease_until)
    VALUES(v_tipoff, f.week_end, v_token, 'running', now() + interval '1 minute');
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 15);
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(gen_random_uuid(), gen_random_uuid()::text, 'Injured', 'Test', 'PG', ARRAY['PG'], 'Out', (f.week_end + 14)::text, 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[2], p.id, 'draft' FROM public.players p WHERE p.first_name='Injured' AND p.nba_team='ZZ' LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[2]::text, true);
  UPDATE private.league_roster_policies SET floor_activated_at=NULL, ir_activated_at=NULL WHERE league_id=f.league_id;
  v_notices_before := public.get_auto_ir_notices(f.league_id, f.season_id);
  SELECT auto_ir INTO v_auto_before FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100) WHERE member_id=f.member_ids[1];
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work((f.week_end + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  SELECT count(*) INTO v_work_before FROM private.work_items WHERE kind='roster-floor' AND league_id=f.league_id;
  v_floor_before := private.run_league_roster_floor(f.league_id, f.season_id);
  UPDATE private.league_roster_policies SET floor_activated_at=now(), ir_activated_at=now() WHERE league_id=f.league_id;
  IF current_setting('app.mode', true) = 'green' THEN
    UPDATE private.league_roster_policies SET floor_activated_at = NULL WHERE league_id = f.league_id;
    UPDATE private.league_roster_policies SET ir_activated_at = NULL WHERE league_id = f.league_id;
  END IF;
  v_notices_after := public.get_auto_ir_notices(f.league_id, f.season_id);
  SELECT auto_ir INTO v_auto_after FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100) WHERE member_id=f.member_ids[1];
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work((f.week_end + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  SELECT count(*) INTO v_work_after FROM private.work_items WHERE kind='roster-floor' AND league_id=f.league_id;
  v_floor_after := private.run_league_roster_floor(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_notices_after = v_notices_before, 'case 7: notices match DB-only');
  PERFORM pg_temp.check_rules(COALESCE(v_auto_after, false) = COALESCE(v_auto_before, false), 'case 7: pre-tipoff admission matches DB-only');
  PERFORM pg_temp.check_rules(v_work_after = v_work_before, 'case 7: roster-floor admission matches DB-only');
  PERFORM pg_temp.check_rules(v_floor_after->>'reason' = v_floor_before->>'reason', 'case 7: floor result matches DB-only');
  PERFORM pg_temp.record_case('7');
  RAISE NOTICE 'PASS case-7';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f1 record; f2 record; f3 record; v_result jsonb; v_count int; v_awards int;
  v_earliest timestamptz; v_claim_player uuid;
BEGIN
  SELECT * INTO f1 FROM pg_temp.floor_missed_week(9932, 2, 16, true);
  SELECT * INTO f2 FROM pg_temp.floor_missed_week(9932, 2, 16, true);
  SELECT * INTO f3 FROM pg_temp.floor_missed_week(9932, 2, 16, false);
  PERFORM pg_temp.floor_roster(f1.league_id, f1.season_id, f1.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f1.league_id, f1.season_id, f1.member_ids[2], 16);
  PERFORM pg_temp.floor_free_agent(f1.league_id, f1.season_id, 9932, 'FA', 40);
  PERFORM pg_temp.floor_roster(f2.league_id, f2.season_id, f2.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f2.league_id, f2.season_id, f2.member_ids[2], 16);
  v_claim_player := pg_temp.floor_free_agent(f2.league_id, f2.season_id, 9932, 'Claim', 10);
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
    VALUES(f2.league_id, f2.season_id, f2.member_ids[1], v_claim_player, 1, f2.week1_end);
  SELECT min((weeks.week_end + time '00:00') AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))
    INTO v_earliest
    FROM public.leagues league
    JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
    JOIN public.season_weeks weeks ON weeks.season_year = season.season_year
   WHERE league.status IN ('active', 'playoffs', 'offseason');
  v_count := public.settle_latest_waiver_runs(v_earliest - interval '1 second');
  PERFORM pg_temp.check_rules(v_count = 0, 'case 8: drain before local midnight settles nothing');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f1.league_id AND process_date=f1.week1_end), 'case 8: no floor-week settlement before local midnight');
  v_count := public.settle_latest_waiver_runs(now());
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f1.league_id AND process_date=f1.week1_end), 'case 8: the fallback settles the floor week');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f2.league_id AND process_date=f2.week1_end), 'case 8: a pending claim blocks the floor week');
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f3.league_id AND process_date=f3.week2_end), 'case 8: a policy-off league keeps the legacy settlement');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f3.league_id AND process_date=f3.week1_end), 'case 8: a policy-off league gets no floor-week settlement');
  v_result := private.run_league_roster_floor(f1.league_id, f1.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed' AND (v_result->>'weekNumber')::int = 1 AND (v_result->>'weekEnd')::date = f1.week1_end, 'case 8: the floor completes the settled week');
  PERFORM pg_temp.check_rules((v_result->>'awarded')::int = 1, 'case 8: the floor awards once');
  v_result := private.run_league_roster_floor(f2.league_id, f2.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'deferred' AND v_result->>'reason' = 'settlement_pending' AND (v_result->>'weekEnd')::date = f2.week1_end, 'case 8: the blocked floor stays settlement_pending');
  v_count := public.settle_latest_waiver_runs(now());
  PERFORM pg_temp.check_rules(v_count = 0, 'case 8: replay inserts nothing');
  v_result := private.run_league_roster_floor(f1.league_id, f1.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=f1.league_id;
  PERFORM pg_temp.check_rules((v_result->>'awarded')::int = 0 AND v_awards = 1, 'case 8: a second floor run awards nothing more');
  PERFORM pg_temp.record_case('8');
  RAISE NOTICE 'PASS case-8';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9916, 2, 16, false);
  UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now() WHERE league_id=f.league_id AND member_id=f.member_ids[1];
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, game_date, token, status, lease_until)
    VALUES(now() + interval '10 minutes', f.week_end, v_token, 'running', now() + interval '1 minute');
  PERFORM public.get_pending_tipoff_members(now() + interval '10 minutes', v_token, ARRAY[]::uuid[], 100);
  PERFORM pg_temp.check_rules((SELECT ir_activated_at FROM private.league_roster_policies WHERE league_id=f.league_id) IS NULL, 'case A: base v61 leaves IR latch NULL');
  PERFORM pg_temp.record_case('A');
  RAISE NOTICE 'PASS case-A';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_result jsonb; v_awards int;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9917, 2, 16, true);
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9917, 0, f.week_end - 13, f.week_end - 7)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
  INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
    VALUES(f.league_id, f.season_id, 0, f.member_ids[1], f.member_ids[2]);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end);
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date) VALUES(f.league_id, f.season_id, f.week_end - 7);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_free_agent(f.league_id, f.season_id, 9917, 'FA', 30);
  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, status)
    VALUES(f.league_id, f.season_id, 1, f.week_end, 'completed');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(v_awards = 0, 'case B: completed latest week gives no award');
  PERFORM pg_temp.record_case('B');
  RAISE NOTICE 'PASS case-B';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_count int;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9918, 2, 16, true);
  UPDATE public.leagues SET timezone='America/Los_Angeles' WHERE id=f.league_id;
  v_count := public.settle_latest_waiver_runs((f.week_end + time '00:30') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=f.week_end) = 0, 'case C: LA league not settled at ET 00:30');
  PERFORM pg_temp.record_case('C');
  RAISE NOTICE 'PASS case-C';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE c record; v_result jsonb; v_awards int;
BEGIN
  SELECT * INTO c FROM pg_temp.rules_fixture(2, 9919);
  UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id=c.league_id AND member_id=c.member_ids[1];
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9919, 1, (now() AT TIME ZONE 'America/New_York')::date - 6, (now() AT TIME ZONE 'America/New_York')::date)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
  INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
    VALUES(c.league_id, c.season_id, 1, c.member_ids[1], c.member_ids[2]);
  PERFORM pg_temp.floor_roster(c.league_id, c.season_id, c.member_ids[1], 14);
  PERFORM pg_temp.floor_roster(c.league_id, c.season_id, c.member_ids[2], 16);
  PERFORM pg_temp.floor_free_agent(c.league_id, c.season_id, 9919, 'ControlFA', 40);
  v_result := public.process_roster_floor_service(c.league_id, c.season_id);
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id=c.league_id;
  PERFORM pg_temp.check_rules(v_awards = 0, 'control: no award');
  PERFORM pg_temp.check_rules(NOT private.league_auto_ir_all_members(c.league_id), 'control: no league-wide IR');
  PERFORM pg_temp.record_case('control');
  RAISE NOTICE 'PASS case-control';
END;
$$;
ROLLBACK;

\set ON_ERROR_STOP on
DO $$
DECLARE v_missing text; v_name text; v_called boolean;
BEGIN
  FOR v_name IN SELECT unnest(ARRAY['1','1b','2','3','4','6','7','8','A','B','C','control']) LOOP
    EXECUTE format('SELECT is_called FROM pg_temp.r3_case_%s', v_name) INTO v_called;
    IF NOT COALESCE(v_called, false) THEN v_missing := concat_ws(',', v_missing, v_name); END IF;
  END LOOP;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'r3 cases failed: %', v_missing; END IF;
END;
$$;
