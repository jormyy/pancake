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
CREATE TEMP SEQUENCE r4_case_2;
CREATE TEMP SEQUENCE r4_case_4;
CREATE TEMP SEQUENCE r4_case_5;
CREATE TEMP SEQUENCE r4_case_6;
CREATE FUNCTION pg_temp.record_case(p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT nextval(%L)', 'pg_temp.r4_case_' || p_name);
END;
$$;

CREATE FUNCTION pg_temp.r4_league(p_year int, p_teams int, p_floor int, p_ir boolean, p_activate boolean)
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

CREATE FUNCTION pg_temp.r4_player(p_league uuid, p_season uuid, p_member uuid, p_name text, p_injury text, p_return text)
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

BEGIN;
CREATE TEMP TABLE r4_calls(function_name text, body jsonb);
CREATE OR REPLACE FUNCTION public.invoke_edge_function(function_name text, body jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO r4_calls VALUES(function_name, body);
END;
$$;
DO $$
DECLARE f record; v_item private.work_items%ROWTYPE; v_item2 private.work_items%ROWTYPE;
  v_tipoff timestamptz := now() + interval '110 seconds';
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_token uuid; v_new_token uuid; v_payload jsonb;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '2') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r4_league(9942, 2, NULL, true, true);
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(f.league_id, f.season_id, f.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled=true, enabled_at=now();
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029942001', 9942, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  SELECT * INTO v_item FROM private.work_claim();
  PERFORM pg_temp.check_rules(v_item.kind = 'pre-tipoff-policy', 'case 2: the tipoff work is claimed');
  PERFORM pg_temp.check_rules(v_item.lease_until <= now() + interval '60 seconds', 'case 2: the tipoff work lease fits inside the window');
  PERFORM private.work_execute(v_item.id, v_item.lease_token);
  SELECT token INTO v_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tipoff AND scope = f.league_id::text;
  PERFORM pg_temp.check_rules(v_token = v_item.lease_token, 'case 2: the dispatch carries the work claim');
  PERFORM pg_temp.check_rules(public.claim_lineup_tipoff_dispatch(v_tipoff, v_token, f.league_id::text) = v_today, 'case 2: the worker claims the tipoff');
  UPDATE private.work_items SET lease_until = now() - interval '1 second' WHERE id = v_item.id;
  UPDATE public.lineup_tipoff_dispatches SET lease_until = now() - interval '1 second' WHERE tipoff_at = v_tipoff AND scope = f.league_id::text;
  PERFORM private.work_claim(0);
  SELECT * INTO v_item FROM private.work_items WHERE id = v_item.id;
  PERFORM pg_temp.check_rules(v_item.status = 'failed' AND v_item.due_at <= now() + interval '10 seconds', 'case 2: the abandoned claim is retryable');
  UPDATE private.work_items SET due_at = now() WHERE id = v_item.id;
  SELECT * INTO v_item2 FROM private.work_claim();
  PERFORM pg_temp.check_rules(v_item2.id = v_item.id AND v_item2.attempts = 2, 'case 2: replacement work is admitted');
  PERFORM private.work_execute(v_item2.id, v_item2.lease_token);
  SELECT token INTO v_new_token FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tipoff;
  PERFORM pg_temp.check_rules(v_new_token <> v_token, 'case 2: the replacement claim fences the abandoned worker');
  PERFORM pg_temp.check_rules((SELECT status = 'queued' AND lease_until > now() FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tipoff), 'case 2: the replacement dispatch is queued');
  PERFORM pg_temp.check_rules(v_tipoff > now(), 'case 2: the replacement runs before tipoff');
  PERFORM pg_temp.check_rules(public.claim_lineup_tipoff_dispatch(v_tipoff, v_new_token, f.league_id::text) = v_today, 'case 2: the replacement worker claims the tipoff');
  SELECT body INTO v_payload FROM r4_calls WHERE function_name = 'lineup-optimizer' ORDER BY ctid DESC LIMIT 1;
  PERFORM pg_temp.check_rules((v_payload->>'tipoffAt')::timestamptz = v_tipoff, 'case 2: the retry keeps unchanged inputs');
  PERFORM pg_temp.record_case('2');
  RAISE NOTICE 'PASS case-2';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; c record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_noon timestamptz := (v_today + time '12:00') AT TIME ZONE 'America/New_York';
  v_injured uuid; r jsonb; v_starters int;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '4') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r4_league(9944, 2, NULL, true, true);
  SELECT * INTO c FROM pg_temp.r4_league(9945, 1, NULL, false, false);
  UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now()
   WHERE league_id=f.league_id AND member_id=f.member_ids[2];
  DELETE FROM private.work_items;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer' AND key=v_today::text), 'case 4: a no-game day admits the daily IR run');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM public.get_pending_auto_ir_members(v_today, p_include_enabled => true)) = 2, 'case 4: both manual and Auto Lineup members are admitted');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_pending_auto_ir_members(v_today, p_include_enabled => true) WHERE league_id=c.league_id), 'case 4: the control league is not admitted');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.nba_games WHERE game_date=v_today AND status='Scheduled'), 'case 4: the fixture has no scheduled games');
  v_injured := pg_temp.r4_player(f.league_id, f.season_id, f.member_ids[1], 'ManualOut', 'Out', (v_today+14)::text);
  PERFORM pg_temp.r4_player(f.league_id, f.season_id, f.member_ids[1], 'ManualHealthy', NULL, NULL);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(r->'moves' @> jsonb_build_array(jsonb_build_object('kind','designate','designatePlayerId',v_injured::text)), 'case 4: the manual team receives its IR move');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM public.roster_players WHERE league_id=f.league_id AND member_id=f.member_ids[1] AND player_id=v_injured), 'case 4: the manual IR move is stored');
  SELECT count(*) INTO v_starters FROM public.weekly_lineups WHERE league_id=f.league_id AND member_id=f.member_ids[1];
  PERFORM pg_temp.check_rules(v_starters = 0, 'case 4: the manual team receives no starter changes');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.lineup_optimizer_settings s WHERE s.league_id=f.league_id AND s.member_id=f.member_ids[1] AND s.enabled), 'case 4: the manual team has no Auto Lineup setting');
  PERFORM pg_temp.record_case('4');
  RAISE NOTICE 'PASS case-4';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '90 seconds';
  v_a uuid; v_b uuid; v_c uuid; v_f0 text; v_f1 text; v_f2 text; v_f3 text; r jsonb;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '5') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r4_league(9946, 2, NULL, true, true);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029946001', 9946, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  v_a := pg_temp.r4_player(f.league_id, f.season_id, f.member_ids[1], 'OutA', 'Out', (v_today+10)::text);
  v_b := pg_temp.r4_player(f.league_id, f.season_id, f.member_ids[1], 'OutB', 'Out', (v_today+10)::text);
  v_c := pg_temp.r4_player(f.league_id, f.season_id, f.member_ids[1], 'HealthyC', NULL, NULL);
  v_f0 := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  UPDATE public.players SET injury_expected_return=(v_today+20)::text WHERE id=v_a;
  v_f1 := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  PERFORM pg_temp.check_rules(v_f1 IS DISTINCT FROM v_f0, 'case 5: a return-date change reopens the fingerprint');
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_c, 1, v_today + 1);
  v_f2 := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  PERFORM pg_temp.check_rules(v_f2 IS DISTINCT FROM v_f1, 'case 5: a reservation reopens the fingerprint');
  DELETE FROM private.work_items;
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until, input_fingerprint)
    VALUES(v_tipoff, f.league_id::text, v_today, gen_random_uuid(), 'succeeded', now(), v_f2);
  INSERT INTO private.work_items(kind, key, due_at, payload, status)
    VALUES('pre-tipoff-policy', v_tipoff::text||':'||f.league_id::text||':'||v_f2, now(), jsonb_build_object('mode','pre_tipoff','tipoffAt',v_tipoff,'leagueId',f.league_id,'fingerprint',v_f2), 'succeeded');
  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND status='pending'), 'case 5: unchanged inputs keep the completed dispatch closed');
  DELETE FROM public.waiver_claims WHERE league_id=f.league_id AND player_id=v_c;
  v_f3 := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  PERFORM pg_temp.check_rules(v_f3 IS DISTINCT FROM v_f2, 'case 5: a released reservation reopens the fingerprint');
  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND status='pending'), 'case 5: a released reservation reopens the completed dispatch');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(r->'moves' @> jsonb_build_array(jsonb_build_object('kind','designate','designatePlayerId',v_a::text)), 'case 5: the extended return date makes the designation unambiguous');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM public.roster_players WHERE league_id=f.league_id AND member_id=f.member_ids[1] AND player_id=v_b), 'case 5: the earlier return date stays active');
  PERFORM pg_temp.record_case('5');
  RAISE NOTICE 'PASS case-5';
END;
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE f record; c record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_noon timestamptz := (v_today + time '12:00') AT TIME ZONE 'America/New_York';
  v_window timestamptz := (v_today + time '19:59') AT TIME ZONE 'America/New_York';
  v_tipoff timestamptz := (v_today + time '20:00') AT TIME ZONE 'America/New_York';
  v_fp text; v_fp_control text;
BEGIN
  IF current_setting('app.case_filter', true) NOT IN ('all', '6') THEN RETURN; END IF;
  SELECT * INTO f FROM pg_temp.r4_league(9947, 2, 16, true, false);
  SELECT * INTO c FROM pg_temp.r4_league(9948, 1, NULL, false, false);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029947001', 9947, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM private.enqueue_pre_tipoff_optimizer(v_window);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind IN ('lineup-optimizer','pre-tipoff','pre-tipoff-policy')), 'case 6: NULL latches dispatch nothing');
  v_fp := private.pre_tipoff_input_fingerprint(v_today);
  DELETE FROM private.league_roster_policies WHERE league_id=f.league_id;
  v_fp_control := private.pre_tipoff_input_fingerprint(v_today);
  PERFORM pg_temp.check_rules(v_fp = v_fp_control, 'case 6: an inactive policy contributes no fingerprint inputs');
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
    VALUES(f.league_id, 16, true, now(), now());
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM private.enqueue_pre_tipoff_optimizer(v_window);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'), 'case 6: activation admits the daily run');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=f.league_id::text), 'case 6: activation admits the tipoff run');
  DELETE FROM private.work_items;
  UPDATE private.league_roster_policies SET floor_activated_at=NULL, ir_activated_at=NULL WHERE league_id=f.league_id;
  PERFORM private.enqueue_lineup_optimizer(v_noon);
  PERFORM private.enqueue_pre_tipoff_optimizer(v_window);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind IN ('lineup-optimizer','pre-tipoff','pre-tipoff-policy')), 'case 6: rollback stops dispatch again');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE league_id=c.league_id), 'case 6: the control league dispatches nothing');
  PERFORM pg_temp.record_case('6');
  RAISE NOTICE 'PASS case-6';
END;
$$;
ROLLBACK;

\set ON_ERROR_STOP on
DO $$
DECLARE v_missing text; v_name text; v_called boolean;
BEGIN
  FOR v_name IN SELECT unnest(ARRAY['2','4','5','6']) LOOP
    IF current_setting('app.case_filter', true) NOT IN ('all', v_name) THEN CONTINUE; END IF;
    EXECUTE format('SELECT is_called FROM pg_temp.r4_case_%s', v_name) INTO v_called;
    IF NOT COALESCE(v_called, false) THEN v_missing := concat_ws(',', v_missing, v_name); END IF;
  END LOOP;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'r4 cases failed: %', v_missing; END IF;
END;
$$;
