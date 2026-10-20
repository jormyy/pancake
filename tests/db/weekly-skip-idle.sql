BEGIN;
SET LOCAL statement_timeout = '60s';
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'local-database-ci-token', true);
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_start date := date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 14;
  v_before int;
BEGIN
  IF EXISTS (SELECT 1 FROM get_live_poll_work()) THEN RAISE EXCEPTION 'Skipped-week gate recipe requires an idle stack'; END IF;
  FOR side IN 1..2 LOOP
    INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
      VALUES(v_users[side], 'authenticated', 'authenticated', v_users[side] || '@example.test', '{}', '{}');
  END LOOP;
  INSERT INTO leagues(id, name, slug, commissioner_id, status, playoff_start_week)
    VALUES(v_league, 'Synthetic skipped-week gate', v_league::text, v_users[1], 'active', 20);
  INSERT INTO league_seasons(id, league_id, season_year, is_current) VALUES(v_season, v_league, 9599, true);
  FOR side IN 1..2 LOOP
    INSERT INTO league_members(id, league_id, user_id, role, team_name)
      VALUES(v_members[side], v_league, v_users[side], CASE WHEN side = 1 THEN 'commissioner' ELSE 'manager' END::league_member_role, 'Side ' || side);
  END LOOP;
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9599, 1, v_start, v_start + 6), (9599, 2, v_start + 7, v_start + 13);
  INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type)
    VALUES(v_league, v_season, 1, v_members[1], v_members[2], 'regular_season');
  PERFORM set_config('request.jwt.claim.sub', v_users[1]::text, true);
  PERFORM update_league_settings_atomic(v_league, '{"skipped_weeks":[1]}'::jsonb);
  IF (SELECT skipped_weeks FROM league_seasons WHERE id = v_season) IS DISTINCT FROM ARRAY[1] THEN
    RAISE EXCEPTION 'Real settings path did not skip week one';
  END IF;
  SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores';
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores') <> v_before THEN
    RAISE EXCEPTION 'Skipped opening week wakes idle scoring';
  END IF;
  INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type)
    VALUES(v_league, v_season, 2, v_members[1], v_members[2], 'regular_season');
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores') <> v_before + 1 THEN
    RAISE EXCEPTION 'First eligible week does not wake idle scoring';
  END IF;
END;
$$;
ROLLBACK;
SELECT 'skipped week one idle gate: PASS';
