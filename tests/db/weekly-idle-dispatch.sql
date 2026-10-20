BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'local-database-ci-token', true);
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_other_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_home uuid := gen_random_uuid();
  v_away uuid := gen_random_uuid();
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_before bigint;
  v_after bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM get_live_poll_work()) THEN
    RAISE EXCEPTION 'This isolated recipe requires an idle local stack';
  END IF;
  INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    VALUES(v_user, 'authenticated', 'authenticated', v_user || '@example.test', '{}', '{}'),
      (v_other_user, 'authenticated', 'authenticated', v_other_user || '@example.test', '{}', '{}');
  INSERT INTO leagues(id, name, slug, commissioner_id, status)
    VALUES(v_league, 'Synthetic idle scoring', v_league::text, v_user, 'active');
  INSERT INTO league_seasons(id, league_id, season_year, is_current)
    VALUES(v_season, v_league, 8993, true);
  INSERT INTO league_members(id, league_id, user_id, role, team_name)
    VALUES(v_home, v_league, v_user, 'commissioner', 'Home'),
      (v_away, v_league, v_other_user, 'manager', 'Away');
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    VALUES(8993, 1, v_today - 13, v_today - 7);
  INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type)
    VALUES(v_league, v_season, 1, v_home, v_away, 'regular_season');
  SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores';
  PERFORM invoke_live_poll_if_due();
  SELECT count(*) INTO v_after FROM edge_invocations WHERE function_name = 'sync-scores';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'Closed week without another game day did not dispatch scoring: before %, after %', v_before, v_after;
  END IF;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores') <> v_after THEN
    RAISE EXCEPTION 'Idle scoring does not respect its retry interval';
  END IF;
END;
$$;
ROLLBACK;
SELECT 'weekly idle scoring dispatch: PASS';
