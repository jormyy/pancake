BEGIN;
\ir hold-dispatcher.sql
\ir rules-support.sql
UPDATE public.nba_games SET status='Final' WHERE status='InProgress';
DELETE FROM private.work_items;

CREATE FUNCTION pg_temp.floor_league(p_year int, p_teams int, p_floor int, p_timezone text DEFAULT 'Pacific/Kiritimati')
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], week_number int, week_end date)
LANGUAGE plpgsql AS $$
DECLARE f record; v_end date := (now() AT TIME ZONE 'America/New_York')::date; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=20, timezone=p_timezone WHERE id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members)
    VALUES(f.league_id, p_floor, true);
  UPDATE private.league_roster_policies SET floor_activated_at = now(), ir_activated_at = now()
   WHERE private.league_roster_policies.league_id = f.league_id;
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
    SELECT f.league_id, f.season_id, true, league.scoring_settings
      FROM public.leagues league WHERE league.id = f.league_id
    ON CONFLICT (league_season_id) DO UPDATE
      SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring;
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
    VALUES(f.league_id, f.season_id, v_end);
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(p_year, 1, v_end - 6, v_end)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key
    DO UPDATE SET week_start=EXCLUDED.week_start, week_end=EXCLUDED.week_end;
  FOR i IN 1..(p_teams / 2) LOOP
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
      VALUES(f.league_id, f.season_id, 1, f.member_ids[i * 2 - 1], f.member_ids[i * 2]);
  END LOOP;
  league_id := f.league_id; season_id := f.season_id; member_ids := f.member_ids;
  week_number := 1; week_end := v_end;
  RETURN NEXT;
END;
$$;

CREATE TEMP TABLE floor_calls(function_name text);
CREATE TEMP TABLE floor_level(level text);
INSERT INTO floor_level VALUES ('normal');

CREATE OR REPLACE FUNCTION public.invoke_edge_function(function_name text, body jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pg_temp.floor_calls(function_name) VALUES(function_name);
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_scheduler_health(p_health jsonb)
RETURNS text LANGUAGE sql AS $$ SELECT level FROM pg_temp.floor_level $$;

DO $$
DECLARE f record; v_item private.work_items%ROWTYPE;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9721, 2, 16);
  PERFORM private.enqueue_scheduled_work(date_trunc('hour', now()) + interval '30 minutes');
  SELECT * INTO v_item FROM private.work_items WHERE kind = 'roster-floor' AND league_id = f.league_id;
  PERFORM pg_temp.check_rules(FOUND, 'the schedule enqueues a roster-floor item');
  PERFORM pg_temp.check_rules(v_item.payload->>'leagueId' = f.league_id::text, 'the item carries the league');
  PERFORM pg_temp.check_rules(v_item.payload->>'leagueSeasonId' = f.season_id::text, 'the item carries the season');
  PERFORM pg_temp.check_rules(v_item.payload->>'weekEnd' = f.week_end::text, 'the item carries the week end');
  PERFORM pg_temp.check_rules(v_item.key LIKE f.league_id::text || ':' || f.week_end::text || ':%', 'the key is scoped to the week');
  PERFORM pg_temp.check_rules((SELECT function_name = 'process-waivers' FROM private.work_kinds WHERE kind = 'roster-floor'),
    'the work kind targets the waiver worker');
END;
$$;

DO $$
DECLARE f_late record; f_early record;
BEGIN
  SELECT * INTO f_late FROM pg_temp.floor_league(9728, 2, 16, 'Pacific/Midway');
  SELECT * INTO f_early FROM pg_temp.floor_league(9729, 2, 16, 'Pacific/Kiritimati');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work(date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f_late.league_id),
    'the schedule waits for the league-local midnight');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f_early.league_id),
    'the schedule enqueues after the league-local midnight');
END;
$$;

DO $$
DECLARE f record; v_zone text; v_et date := (now() AT TIME ZONE 'America/New_York')::date;
  v_local date; v_work int; v_result jsonb;
BEGIN
  SELECT name INTO v_zone
    FROM pg_timezone_names
   WHERE (now() AT TIME ZONE name)::date > v_et
   ORDER BY (now() AT TIME ZONE name)::date DESC, name
   LIMIT 1;
  IF v_zone IS NULL THEN
    RAISE NOTICE 'case: no timezone ahead of New York; skipping';
    RETURN;
  END IF;
  v_local := (now() AT TIME ZONE v_zone)::date;
  SELECT * INTO f FROM pg_temp.floor_league(9731, 2, 16, v_zone);
  UPDATE public.season_weeks SET week_start = v_local - 6, week_end = v_local
   WHERE season_year = 9731 AND week_number = 1;
  DELETE FROM private.waiver_run_settlements WHERE league_id = f.league_id;
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
    VALUES (f.league_id, f.season_id, v_local);
  UPDATE public.nba_games SET status = 'Final'
   WHERE game_date IN (v_et - 1, v_et, v_local - 1, v_local);
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work(date_trunc('hour', now()) + interval '15 minutes');
  SELECT count(*) INTO v_work FROM private.work_items
   WHERE kind = 'roster-floor' AND league_id = f.league_id;
  PERFORM pg_temp.check_rules(v_work = 1,
    'the schedule admits a league whose local week_end is after the Eastern date');
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed',
    'the floor admits a league whose local week_end is after the Eastern date');
  DELETE FROM private.roster_floor_weeks WHERE league_id = f.league_id;
  DELETE FROM private.work_items;
  UPDATE private.worker_controls SET paused = false, scheduler_last_dispatch_at = NULL WHERE id;
  UPDATE pg_temp.floor_level SET level = 'paused';
  PERFORM public.dispatch_work();
  SELECT count(*) INTO v_work FROM private.work_items
   WHERE kind = 'roster-floor' AND league_id = f.league_id;
  PERFORM pg_temp.check_rules(v_work = 1,
    'dispatch admits a league whose local week_end is after the Eastern date');
  UPDATE pg_temp.floor_level SET level = 'normal';
END;
$$;

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9730, 2, 16);
  DELETE FROM private.work_items;
  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, status, completed_at)
    VALUES(f.league_id, f.season_id, 1, f.week_end, 'completed', now());
  PERFORM private.enqueue_scheduled_work(date_trunc('hour', now()) + interval '45 minutes');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f.league_id),
    'a completed week is not enqueued again');
  UPDATE private.roster_floor_weeks SET status='pending', completed_at=NULL WHERE league_id=f.league_id;
  PERFORM private.enqueue_scheduled_work(date_trunc('hour', now()) + interval '75 minutes');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f.league_id),
    'an open week keeps the retry cadence');
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9722, 2, 16);
  DELETE FROM private.work_items;
  DELETE FROM pg_temp.floor_calls;
  PERFORM private.work_enqueue('roster-floor', f.league_id::text || ':' || f.week_end::text || ':1', now(),
    jsonb_build_object('leagueId', f.league_id, 'leagueSeasonId', f.season_id, 'weekEnd', f.week_end, 'bucket', 1),
    f.league_id);
  PERFORM public.dispatch_work();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM pg_temp.floor_calls WHERE function_name = 'process-waivers'),
    'dispatch invokes the waiver worker for the roster floor');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f.league_id AND status = 'running'),
    'the roster-floor item is claimed');
END;
$$;

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9723, 2, 16);
  DELETE FROM private.work_items;
  UPDATE private.worker_controls SET paused=false, scheduler_last_dispatch_at=NULL WHERE id;
  UPDATE pg_temp.floor_level SET level='paused';
  PERFORM public.dispatch_work();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f.league_id), 'a paused scheduler still enqueues the roster floor');
  DELETE FROM private.work_items;
  UPDATE private.worker_controls SET scheduler_last_dispatch_at=NULL WHERE id;
  UPDATE pg_temp.floor_level SET level='shed';
  PERFORM public.dispatch_work();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f.league_id), 'a shedding scheduler still enqueues the roster floor');
  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, status, completed_at)
    VALUES(f.league_id, f.season_id, 1, f.week_end, 'completed', now());
  DELETE FROM private.work_items;
  UPDATE private.worker_controls SET scheduler_last_dispatch_at=NULL WHERE id;
  PERFORM public.dispatch_work();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE kind = 'roster-floor' AND league_id = f.league_id), 'a shedding scheduler skips a completed week');
  DELETE FROM private.roster_floor_weeks WHERE league_id = f.league_id;
  DELETE FROM private.work_items;
  UPDATE private.worker_controls SET paused=true WHERE id;
  PERFORM pg_temp.check_rules(public.dispatch_work() = 0, 'a hard pause claims nothing');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind = 'roster-floor'),
    'a hard pause enqueues no roster floor');
  UPDATE private.worker_controls SET paused=false WHERE id;
  UPDATE pg_temp.floor_level SET level='normal';
END;
$$;

DO $$
DECLARE f record; v_ready jsonb; v_zone text; v_midnight timestamptz; v_et date := (now() AT TIME ZONE 'America/New_York')::date; v_count int;
BEGIN
  SELECT name INTO v_zone
    FROM pg_timezone_names
   WHERE ((v_et + time '00:00') AT TIME ZONE name) > now()
   ORDER BY ((v_et + time '00:00') AT TIME ZONE name) DESC
   LIMIT 1;
  IF v_zone IS NOT NULL THEN
    RAISE NOTICE 'case: waiting branch zone=%', v_zone;
    SELECT * INTO f FROM pg_temp.floor_league(9724, 2, 16, v_zone);
    v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
    PERFORM pg_temp.check_rules(v_ready->>'reason' = 'week_not_started', 'a league behind New York has not reached the week_end date');
  ELSE
    RAISE NOTICE 'case: deterministic guard branch';
    SELECT * INTO f FROM pg_temp.floor_league(9724, 2, 16, 'Pacific/Kiritimati');
    DELETE FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=f.week_end;
    v_midnight := (f.week_end + time '00:00') AT TIME ZONE 'Pacific/Kiritimati';
    v_count := private.settle_waiver_runs('Pacific/Kiritimati', f.week_end, v_midnight - interval '1 minute');
    PERFORM pg_temp.check_rules(v_count = 0, 'the floor waits for the league midnight before settlement');
    v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
    PERFORM pg_temp.check_rules(v_ready->>'reason' = 'settlement_pending', 'the floor waits for the league midnight while settlement is pending');
    v_count := private.settle_waiver_runs('Pacific/Kiritimati', f.week_end, v_midnight + interval '1 minute');
    PERFORM pg_temp.check_rules(v_count = 1, 'the floor settles after the league midnight');
    v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
    PERFORM pg_temp.check_rules((v_ready->>'ready')::boolean, 'the floor is ready after the league midnight in the guard branch');
  END IF;
  UPDATE public.leagues SET timezone='Pacific/Kiritimati' WHERE id=f.league_id;
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules((v_ready->>'ready')::boolean, 'the floor is ready after the league midnight');
  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, status)
    VALUES(f.league_id, f.season_id, 1, f.week_end - 1, 'completed');
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end - 1);
  PERFORM pg_temp.check_rules(v_ready->>'reason' = 'week_ended', 'a past week is closed');
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end + 2);
  PERFORM pg_temp.check_rules(v_ready->>'reason' = 'week_not_started', 'a future week is not open');
END;
$$;

DO $$
DECLARE f record; v_ready jsonb; v_player uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9725, 2, 16);
  v_player := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, v_player::text, 'Claim', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_player, 1, f.week_end);
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules(v_ready->>'reason' = 'claims_pending', 'a due claim blocks the week');
  UPDATE public.waiver_claims SET status='succeeded', processed_at=now() WHERE league_id=f.league_id;
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules((v_ready->>'ready')::boolean, 'the week opens after the claim resolves');
END;
$$;

DO $$
DECLARE f record; v_ready jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9726, 2, 16);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029726001', 9726, 1, (now() AT TIME ZONE 'America/New_York')::date,
      'AA', 'AB', 'InProgress', now() - interval '1 hour');
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules(v_ready->>'reason' = 'game_in_progress', 'a live game blocks the week');
  UPDATE public.nba_games SET status='Final' WHERE nba_game_id='0029726001';
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules((v_ready->>'ready')::boolean, 'the week opens after the game ends');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029726002', 9726, 1, (now() AT TIME ZONE 'America/New_York')::date,
      'AC', 'AD', 'Scheduled', now() - interval '1 hour');
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules(v_ready->>'reason' = 'game_in_progress',
    'a stale scheduled game past tip-off blocks the week');
  UPDATE public.nba_games SET status='Final' WHERE nba_game_id='0029726002';
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time, started_at)
    VALUES(gen_random_uuid(), '0029726003', 9726, 1, (now() AT TIME ZONE 'America/New_York')::date,
      'AE', 'AF', 'Scheduled', NULL, now() - interval '1 hour');
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules(v_ready->>'reason' = 'game_in_progress',
    'a started game without a final status blocks the week');
  UPDATE public.nba_games SET status='Final' WHERE nba_game_id='0029726003';
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029726004', 9726, 1, (now() AT TIME ZONE 'America/New_York')::date,
      'AG', 'AH', 'Scheduled', now() + interval '2 hours');
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end);
  PERFORM pg_temp.check_rules((v_ready->>'ready')::boolean, 'a future scheduled game does not block the week');
END;
$$;

DO $$
DECLARE f record; v_result jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9727, 2, 16);
  DELETE FROM public.matchups WHERE league_id = f.league_id;
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'no_week', 'a week without matchups does not run');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_weeks WHERE league_id = f.league_id),
    'a week without matchups records nothing');
END;
$$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
