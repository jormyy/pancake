\set ON_ERROR_STOP on
\set expected_db_port 58022
\getenv expected_db_port PANCAKE_TEST_DB_PORT
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT' = :'expected_db_port' AS local_target \gset
\if :local_target
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private local database.'; END $$;
\endif
SELECT md5(pg_get_functiondef('public.view_context(uuid,uuid,jsonb)'::regprocedure)) AS original_context_hash \gset
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE local_day_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9542,'active');
DO $$
DECLARE fixture record; function_name text; definition text; result jsonb; scenario record;
BEGIN
  SELECT * INTO fixture FROM local_day_fixture;
  PERFORM set_config('request.jwt.claim.sub',fixture.user_ids[1]::text,true);
  result := public.view_context(fixture.league_id,fixture.member_ids[1]);
  PERFORM pg_temp.check_rules(result->>'today'=(now() AT TIME ZONE 'America/Los_Angeles')::date::text,'Live context uses the default league timezone');
  PERFORM pg_temp.check_rules(result->>'seasonId'=fixture.season_id::text,'Live context preserves its current season');
  FOREACH function_name IN ARRAY ARRAY['view_context','view_home','view_lineup','view_roster','view_players','view_claims'] LOOP
    SELECT pg_get_functiondef(format('public.%I(uuid,uuid,jsonb)',function_name)::regprocedure) INTO definition;
    EXECUTE replace(definition,'now()','(current_setting(''pancake.view_day_clock'')::timestamptz)');
  END LOOP;
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(fixture.league_id,fixture.season_id,1,fixture.member_ids[1],fixture.member_ids[2]),
      (fixture.league_id,fixture.season_id,2,fixture.member_ids[1],fixture.member_ids[2]);
  FOR scenario IN SELECT * FROM (VALUES
    ('summer evening','2026-10-28T04:21:00Z'::timestamptz,'2026-10-27'::date,'2026-10-27'::date,1),
    ('summer midnight','2026-10-28T07:01:00Z'::timestamptz,'2026-10-27'::date,'2026-10-28'::date,2),
    ('spring evening','2026-03-09T04:21:00Z'::timestamptz,'2026-03-08'::date,'2026-03-08'::date,1),
    ('spring midnight','2026-03-09T07:01:00Z'::timestamptz,'2026-03-08'::date,'2026-03-09'::date,2),
    ('fall evening','2026-11-02T05:21:00Z'::timestamptz,'2026-11-01'::date,'2026-11-01'::date,1),
    ('fall midnight','2026-11-02T08:01:00Z'::timestamptz,'2026-11-01'::date,'2026-11-02'::date,2)
  ) cases(label,clock,boundary_day,expected_day,expected_week) LOOP
    PERFORM set_config('pancake.view_day_clock',scenario.clock::text,true);
    DELETE FROM public.season_weeks WHERE season_year=9542;
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
      VALUES(9542,1,scenario.boundary_day-6,scenario.boundary_day),
        (9542,2,scenario.boundary_day+1,scenario.boundary_day+7);
    result := public.view_context(fixture.league_id,fixture.member_ids[1]);
    PERFORM pg_temp.check_rules(result->>'today'=scenario.expected_day::text,scenario.label || ' context day');
    PERFORM pg_temp.check_rules((result->>'weekNumber')::integer=scenario.expected_week,scenario.label || ' context week');
    FOREACH function_name IN ARRAY ARRAY['view_home','view_roster','view_players','view_lineup','view_claims'] LOOP
      EXECUTE format('SELECT public.%I($1,$2,$3)',function_name) INTO result
        USING fixture.league_id,fixture.member_ids[1],'{"availability":"mine"}'::jsonb;
      PERFORM pg_temp.check_rules(result->'context'->>'today'=scenario.expected_day::text,scenario.label || ' ' || function_name || ' day');
      PERFORM pg_temp.check_rules((result->'context'->>'weekNumber')::integer=scenario.expected_week,scenario.label || ' ' || function_name || ' week');
      IF function_name IN ('view_home','view_lineup','view_players') THEN
        PERFORM pg_temp.check_rules((SELECT count(*)=1 AND min(day->>'date')=scenario.expected_day::text
          FROM jsonb_array_elements(result->'weekDays') day WHERE (day->>'isToday')::boolean),scenario.label || ' ' || function_name || ' day strip');
      END IF;
      IF function_name='view_home' THEN
        PERFORM pg_temp.check_rules(result->>'selectedDate'=scenario.expected_day::text,scenario.label || ' Home selection');
      ELSIF function_name='view_lineup' THEN
        PERFORM pg_temp.check_rules(result->>'date'=scenario.expected_day::text,scenario.label || ' Lineup selection');
      END IF;
    END LOOP;
    result := public.view_lineup(fixture.league_id,fixture.member_ids[1],jsonb_build_object('date',scenario.boundary_day));
    PERFORM pg_temp.check_rules(result->>'date'=scenario.boundary_day::text,scenario.label || ' explicit date is preserved');
    PERFORM pg_temp.check_rules(result->'context'->>'today'=scenario.expected_day::text,scenario.label || ' explicit date does not replace today');
  END LOOP;
  PERFORM set_config('pancake.view_day_clock','2026-10-28T04:21:00Z',true);
  UPDATE public.leagues SET timezone='Asia/Tokyo' WHERE id=fixture.league_id;
  result := public.view_context(fixture.league_id,fixture.member_ids[1]);
  PERFORM pg_temp.check_rules(result->>'today'='2026-10-28','Configured timezone changes the server day');
  result := public.view_context(fixture.league_id,fixture.member_ids[1],'{"weekNumber":9,"date":"2099-01-01"}');
  PERFORM pg_temp.check_rules(result->>'weekNumber'='9','Explicit week remains supported');
  PERFORM pg_temp.check_rules(result->>'today'='2026-10-28','Client date cannot override the server day');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_context(%L,%L)',fixture.league_id,fixture.member_ids[2]),'This screen is not available.','Another member remains private');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_context(%L,%L,%L)',fixture.league_id,fixture.member_ids[1],'{"seasonId":"00000000-0000-0000-0000-000000000001"}'),'This season is not available.','Unknown season remains rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_context(%L,%L,%L)',fixture.league_id,fixture.member_ids[1],'[]'),'View parameters must be an object.','Invalid parameters remain rejected');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
SELECT md5(pg_get_functiondef('public.view_context(uuid,uuid,jsonb)'::regprocedure)) = :'original_context_hash' AS source_restored \gset
\if :source_restored
\else
  DO $$ BEGIN RAISE EXCEPTION 'The clock fixture changed the saved function.'; END $$;
\endif
