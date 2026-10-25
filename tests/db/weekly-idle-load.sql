BEGIN;
SET LOCAL statement_timeout = '180s';
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'local-database-ci-token', true);
CREATE TEMP TABLE idle_load_leagues(id uuid PRIMARY KEY);
CREATE TEMP TABLE idle_load_timings(scenario text, milliseconds numeric);
DO $$
DECLARE
  v_users uuid[] := ARRAY[]::uuid[];
  v_members uuid[];
  v_league uuid;
  v_season uuid;
  v_user uuid;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF EXISTS (SELECT 1 FROM get_live_poll_work()) THEN RAISE EXCEPTION 'Load recipe requires an idle stack'; END IF;
  FOR n IN 1..12 LOOP
    v_user := gen_random_uuid();
    v_users := array_append(v_users, v_user);
    INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
      VALUES(v_user, 'authenticated', 'authenticated', v_user || '@example.test', '{}', '{}');
  END LOOP;
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    SELECT year, week, v_today - (9398 - year) * 364 - (23 - week) * 7,
      v_today - (9398 - year) * 364 - (23 - week) * 7 + 6
    FROM generate_series(9396, 9398) year CROSS JOIN generate_series(1, 22) week;
  FOR n IN 1..30 LOOP
    v_league := gen_random_uuid();
    INSERT INTO idle_load_leagues VALUES(v_league);
    INSERT INTO leagues(id, name, slug, commissioner_id, status, team_limit)
      VALUES(v_league, 'Synthetic idle load', v_league::text, v_users[1], 'active', 12);
    v_members := ARRAY[]::uuid[];
    FOR side IN 1..12 LOOP
      v_members := array_append(v_members, gen_random_uuid());
      INSERT INTO league_members(id, league_id, user_id, role, team_name)
        VALUES(v_members[side], v_league, v_users[side], CASE WHEN side = 1 THEN 'commissioner' ELSE 'manager' END::league_member_role, 'Synthetic ' || side);
    END LOOP;
    FOR year IN 9396..9398 LOOP
      v_season := gen_random_uuid();
      INSERT INTO league_seasons(id, league_id, season_year, is_current)
        VALUES(v_season, v_league, year, year = 9398);
      INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type)
        SELECT v_league, v_season, week, v_members[pair], v_members[pair + 1], 'regular_season'
        FROM generate_series(1, 22) week CROSS JOIN generate_series(1, 11, 2) pair;
    END LOOP;
  END LOOP;
END;
$$;
ANALYZE leagues;
ANALYZE league_seasons;
ANALYZE league_members;
ANALYZE matchups;
ANALYZE season_weeks;
SELECT 'SYNTHETIC' AS provenance,
  (SELECT count(*) FROM idle_load_leagues) AS leagues,
  (SELECT count(*) FROM league_members WHERE league_id IN (SELECT id FROM idle_load_leagues)) AS teams,
  (SELECT count(*) FROM league_seasons WHERE league_id IN (SELECT id FROM idle_load_leagues)) AS seasons,
  (SELECT count(*) FROM matchups WHERE league_id IN (SELECT id FROM idle_load_leagues)) AS matchups;
EXPLAIN (ANALYZE, BUFFERS) SELECT invoke_live_poll_if_due();
DO $$
DECLARE
  v_start timestamptz;
  v_before int;
  v_after int;
  v_scenario text;
BEGIN
  FOREACH v_scenario IN ARRAY ARRAY['closed unfinished weeks', 'All-Star break', 'finalized playoff grace', 'offseason', 'archived'] LOOP
    IF v_scenario = 'All-Star break' THEN
      UPDATE matchups SET is_finalized = true, finalized_at = now() WHERE league_id IN (SELECT id FROM idle_load_leagues);
      UPDATE season_weeks SET week_start = week_start - 7, week_end = week_end - 7 WHERE season_year = 9398;
      INSERT INTO private.score_week_certificates(league_season_id, week_number, input_token)
        SELECT season.id, week, capture_score_inputs(season.id, week)
        FROM league_seasons season CROSS JOIN generate_series(1, 22) week
        WHERE season.league_id IN (SELECT id FROM idle_load_leagues) AND season.is_current;
    ELSIF v_scenario = 'finalized playoff grace' THEN
      UPDATE leagues SET status = 'playoffs' WHERE id IN (SELECT id FROM idle_load_leagues);
      UPDATE matchups SET matchup_type = 'playoff_final', is_finalized = true, finalized_at = now()
        WHERE league_id IN (SELECT id FROM idle_load_leagues) AND week_number = 22;
    ELSIF v_scenario = 'offseason' THEN
      UPDATE leagues SET status = 'offseason' WHERE id IN (SELECT id FROM idle_load_leagues);
    ELSIF v_scenario = 'archived' THEN
      UPDATE leagues SET status = 'archived' WHERE id IN (SELECT id FROM idle_load_leagues);
    END IF;
    FOR attempt IN 1..20 LOOP
      UPDATE edge_invocations SET queued_at = now() - interval '31 minutes'
        WHERE function_name = 'sync-scores' AND queued_at >= now();
      SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores';
      v_start := clock_timestamp();
      PERFORM invoke_live_poll_if_due();
      INSERT INTO idle_load_timings VALUES(v_scenario, extract(epoch FROM clock_timestamp() - v_start) * 1000);
      SELECT count(*) INTO v_after FROM edge_invocations WHERE function_name = 'sync-scores';
      IF v_after - v_before <> (CASE WHEN v_scenario = 'closed unfinished weeks' THEN 1 ELSE 0 END) THEN
        RAISE EXCEPTION 'Unexpected idle dispatch count for %', v_scenario;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
SELECT scenario, count(*) AS calls, round(avg(milliseconds), 3) AS mean_ms,
  round(max(milliseconds), 3) AS max_ms FROM idle_load_timings GROUP BY scenario ORDER BY scenario;
ROLLBACK;
