BEGIN;
\ir rules-support.sql
UPDATE public.nba_games SET status='Final' WHERE status='InProgress';

CREATE FUNCTION pg_temp.floor_league(p_year int, p_teams int, p_floor int, p_roster_size int DEFAULT 20, p_auto_ir boolean DEFAULT true)
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], week_number int, week_end date)
LANGUAGE plpgsql AS $$
DECLARE f record; v_end date := (now() AT TIME ZONE 'America/New_York')::date; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=p_roster_size, timezone='Pacific/Kiritimati' WHERE id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members)
    VALUES(f.league_id, p_floor, p_auto_ir);
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

CREATE FUNCTION pg_temp.floor_roster(p_league uuid, p_season uuid, p_member uuid, p_count int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int; v_player uuid;
BEGIN
  FOR i IN 1..p_count LOOP
    v_player := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_player, v_player::text, 'Roster' || i, 'Test', 'PG', ARRAY['PG'], 'Healthy', 'ZZ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES(p_league, p_season, p_member, v_player, 'draft');
  END LOOP;
END;
$$;

CREATE FUNCTION pg_temp.floor_active(p_league uuid, p_season uuid, p_member uuid)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.roster_players
   WHERE league_id = p_league AND league_season_id = p_season AND member_id = p_member
     AND NOT is_on_ir AND NOT is_on_taxi
$$;

CREATE FUNCTION pg_temp.floor_isolate(p_league uuid, p_season uuid, p_keep uuid[])
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, clears_at)
  SELECT p_league, p_season, player.id, now() + interval '1 day'
    FROM public.players player
   WHERE NOT (player.id = ANY(p_keep))
     AND NOT EXISTS (
       SELECT 1 FROM public.roster_players roster
        WHERE roster.league_id = p_league
          AND roster.league_season_id = p_season
          AND roster.player_id = player.id
     )
$$;

CREATE FUNCTION pg_temp.floor_live_game(p_year int, p_game_id text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), p_game_id, p_year, 1, (now() AT TIME ZONE 'America/New_York')::date,
      'QQ', 'QO', 'InProgress', now() - interval '1 hour')
$$;

CREATE FUNCTION pg_temp.floor_remove_member(p_league uuid, p_season uuid, p_member uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.roster_players
   WHERE league_id = p_league AND league_season_id = p_season AND member_id = p_member;
  DELETE FROM public.waiver_priorities
   WHERE league_id = p_league AND league_season_id = p_season AND member_id = p_member;
  DELETE FROM public.matchups
   WHERE league_id = p_league AND league_season_id = p_season
     AND (home_member_id = p_member OR away_member_id = p_member);
  DELETE FROM public.league_members WHERE id = p_member AND league_id = p_league;
END;
$$;

CREATE FUNCTION pg_temp.floor_join_member(p_league uuid, p_season uuid, p_priority int, p_count int)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_user uuid := gen_random_uuid(); v_member uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES(v_user, 'authenticated', 'authenticated', v_user || '@example.test', 'x', now(), '{}', '{}', now(), now());
  INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
    VALUES(v_member, p_league, v_user, 'manager', 'Newcomer');
  INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
    VALUES(p_league, p_season, v_member, p_priority);
  PERFORM pg_temp.floor_roster(p_league, p_season, v_member, p_count);
  RETURN v_member;
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid; v_result jsonb; v_order uuid[];
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9720, 3, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9720, 'First', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9720, 'Second', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  PERFORM pg_temp.floor_live_game(9720, '0029720001');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'game_in_progress', 'a live game defers the membership week');
  UPDATE private.roster_floor_weeks
     SET team_order = ARRAY[f.member_ids[1], f.member_ids[3], f.member_ids[2]]
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.floor_remove_member(f.league_id, f.season_id, f.member_ids[3]);
  UPDATE public.nba_games SET status = 'Final' WHERE nba_game_id = '0029720001';
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed', 'the week completes after a member departs');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[1] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'the first surviving stored team gets the best player');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[2] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the second surviving stored team gets the next player');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND member_id = f.member_ids[3]), 'the departed member is never awarded');
  SELECT team_order INTO v_order FROM private.roster_floor_weeks
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.check_rules(v_order = ARRAY[f.member_ids[1], f.member_ids[2]],
    'the stored order drops the departed member');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16
    AND pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[2]) = 16,
    'both surviving teams reach the floor');
END;
$$;

DO $$
DECLARE f record; p1 uuid; v_result jsonb; v_member uuid; v_order uuid[];
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9721, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9721, 'Newcomer fill', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  PERFORM pg_temp.floor_live_game(9721, '0029721001');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'game_in_progress', 'a live game defers the full week');
  UPDATE private.roster_floor_weeks
     SET team_order = ARRAY[f.member_ids[1], f.member_ids[2]]
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  v_member := pg_temp.floor_join_member(f.league_id, f.season_id, 3, 15);
  UPDATE public.nba_games SET status = 'Final' WHERE nba_game_id = '0029721001';
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed', 'the week completes after a member joins');
  PERFORM pg_temp.check_rules((SELECT member_id = v_member FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'the newcomer is filled');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, v_member) = 16,
    'the newcomer reaches the floor');
  SELECT team_order INTO v_order FROM private.roster_floor_weeks
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.check_rules(v_order = ARRAY[f.member_ids[1], f.member_ids[2], v_member],
    'the newcomer is appended to the stored order');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid; v_result jsonb; v_member uuid; v_order uuid[];
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9722, 3, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9722, 'Best', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9722, 'Next', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  PERFORM pg_temp.floor_live_game(9722, '0029722001');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'reason' = 'game_in_progress', 'a live game defers the exhausted week');
  UPDATE private.roster_floor_weeks
     SET team_order = ARRAY[f.member_ids[2], f.member_ids[1], f.member_ids[3]]
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.floor_remove_member(f.league_id, f.season_id, f.member_ids[3]);
  v_member := pg_temp.floor_join_member(f.league_id, f.season_id, 3, 15);
  UPDATE public.nba_games SET status = 'Final' WHERE nba_game_id = '0029722001';
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed', 'the exhausted week completes');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[2] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'the exhausted pool gives the first surviving stored team the best player');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[1] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the exhausted pool gives the second surviving stored team the next player');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND member_id = v_member), 'the newcomer gets nothing from an exhausted pool');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, v_member) = 15,
    'the newcomer stays short');
  SELECT team_order INTO v_order FROM private.roster_floor_weeks
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.check_rules(v_order = ARRAY[f.member_ids[2], f.member_ids[1], v_member],
    'the stored order keeps survivors before the newcomer');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid; p3 uuid; p4 uuid; v_result jsonb; v_order uuid[];
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9723, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 14);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9723, 'One', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9723, 'Two', 30);
  p3 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9723, 'Three', 20);
  p4 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9723, 'Four', 10);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2, p3, p4]);
  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, team_order, status)
    VALUES(f.league_id, f.season_id, 1, f.week_end, ARRAY[f.member_ids[2], f.member_ids[1]], 'pending');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed', 'the competing week completes');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[2] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'the first stored team gets the best player');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[1] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the second stored team gets the next player');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[2] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p3), 'the second pass returns to the first stored team');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[1] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p4), 'the second pass returns to the second stored team');
  SELECT team_order INTO v_order FROM private.roster_floor_weeks
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.check_rules(v_order = ARRAY[f.member_ids[2], f.member_ids[1]], 'the stored order is unchanged');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed' AND (v_result->>'awarded')::int = 0,
    'a repeat run returns completed with zero awards');
  PERFORM pg_temp.check_rules((SELECT count(*) = 4 FROM private.roster_floor_awards WHERE league_id = f.league_id),
    'a repeat run adds no awards');
END;
$$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
