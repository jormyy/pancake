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

CREATE FUNCTION pg_temp.floor_free_agent(p_league uuid, p_season uuid, p_year int, p_name text, p_avg numeric,
  p_injury text DEFAULT NULL, p_id uuid DEFAULT NULL, p_team text DEFAULT 'ZZ')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, v_player::text, p_name, 'Test', 'PG', ARRAY['PG'], p_injury, p_team);
  INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
    VALUES(p_league, p_season, p_year, v_player, '{}'::jsonb, p_avg, 1);
  RETURN v_player;
END;
$$;

CREATE FUNCTION pg_temp.floor_no_stats_player(p_name text, p_team text DEFAULT 'ZZ', p_injury text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, v_player::text, p_name, 'Test', 'PG', ARRAY['PG'], p_injury, p_team);
  RETURN v_player;
END;
$$;

CREATE FUNCTION pg_temp.floor_roster(p_league uuid, p_season uuid, p_member uuid, p_count int,
  p_location text DEFAULT 'active', p_injury text DEFAULT 'Healthy')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int; v_player uuid;
BEGIN
  FOR i IN 1..p_count LOOP
    v_player := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_player, v_player::text, 'Roster' || i, 'Test', 'PG', ARRAY['PG'], p_injury, 'ZZ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir, is_on_taxi)
      VALUES(p_league, p_season, p_member, v_player, 'draft', p_location = 'ir', p_location = 'taxi');
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

DO $$
DECLARE f record; i int; v_keep uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9701, 4, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[4], 17);
  FOR i IN 1..10 LOOP
    v_keep := v_keep || pg_temp.floor_free_agent(f.league_id, f.season_id, 9701, 'FA' || i, 30 - i);
  END LOOP;
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, v_keep);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16, '14 becomes 16');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[2]) = 16, '15 becomes 16');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[3]) = 16, '16 stays 16');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[4]) = 17, '17 stays 17');
  PERFORM pg_temp.check_rules((SELECT count(*) = 3 FROM public.roster_transactions
    WHERE league_id = f.league_id AND transaction_type = 'fa_add'), 'one fa_add transaction per add');
  PERFORM pg_temp.check_rules((SELECT count(*) = 3 FROM private.roster_floor_awards award
    JOIN public.roster_transactions tx ON tx.league_id = award.league_id
      AND tx.league_season_id = award.league_season_id AND tx.member_id = award.member_id
      AND tx.player_id = award.player_id AND tx.transaction_type = 'fa_add'
    WHERE award.league_id = f.league_id), 'each floor award writes exactly one fa_add transaction');
  PERFORM pg_temp.check_rules((SELECT count(*) = 3 FROM public.roster_players
    WHERE league_id = f.league_id AND acquired_via = 'roster_floor'), 'adds use their own acquired_via');
  PERFORM set_config('request.jwt.claim.sub', (SELECT user_id::text FROM public.league_members WHERE id = f.member_ids[1]), true);
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.get_league_activity_feed(f.league_id, 100, 0)
    WHERE transaction_type = 'fa_add' AND member_id = f.member_ids[1]), 'the activity feed returns the floor adds as fa_add');
  PERFORM pg_temp.check_rules((SELECT status = 'completed' FROM private.roster_floor_weeks
    WHERE league_id = f.league_id), 'the week is recorded as completed');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid; p3 uuid; p4 uuid; v_order uuid[];
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9702, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 14);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9702, 'Best', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9702, 'Second', 30);
  p3 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9702, 'Third', 20);
  p4 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9702, 'Fourth', 10);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2, p3, p4]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT team_order INTO v_order FROM private.roster_floor_weeks WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(array_length(v_order, 1) = 2, 'both short teams are stored');
  PERFORM pg_temp.check_rules((SELECT member_id = v_order[1] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'the first pass awards the best player to the first stored team');
  PERFORM pg_temp.check_rules((SELECT member_id = v_order[2] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the first pass awards the next player to the second stored team');
  PERFORM pg_temp.check_rules((SELECT member_id = v_order[1] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p3), 'the second pass returns to the first stored team');
  PERFORM pg_temp.check_rules((SELECT member_id = v_order[2] FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p4), 'the second pass returns to the second stored team');
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((SELECT team_order = v_order FROM private.roster_floor_weeks
    WHERE league_id = f.league_id), 'a repeat run reuses the stored order');
  PERFORM pg_temp.check_rules((SELECT count(*) = 4 FROM private.roster_floor_awards
    WHERE league_id = f.league_id), 'a repeat run awards nothing');
END;
$$;

DO $$
DECLARE f record; p1 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9703, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 14);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9703, 'Only', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id), 'the exhausted pool awards one player');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.roster_players
    WHERE league_id = f.league_id AND acquired_via = 'roster_floor'), 'only one add');
  PERFORM pg_temp.check_rules((SELECT status = 'completed' FROM private.roster_floor_weeks
    WHERE league_id = f.league_id), 'the exhausted week completes cleanly');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1])
    + pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[2]) = 29, 'teams stay short');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid; v_result jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9704, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9704, 'Claimed', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9704, 'Floor', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
    VALUES(f.league_id, f.season_id, f.member_ids[1], p1, 1, f.week_end);
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'deferred' AND v_result->>'reason' = 'claims_pending',
    'a due claim blocks the floor');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id),
    'the blocked run awards nothing');
  PERFORM public.process_due_waiver_claims_atomic(f.week_end);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players
    WHERE league_id = f.league_id AND player_id = p1), 'the waiver claim resolves');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed', 'the floor runs after the claims resolve');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the floor awards the next player');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'the waiver winner is not re-awarded');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16,
    'the team reaches the floor');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9705, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9705, 'Future', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9705, 'Available', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
    VALUES(f.league_id, f.season_id, f.member_ids[1], p1, 1, f.week_end + 1);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the floor awards an unclaimed player');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'a future claim keeps its player out of the pool');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9706, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9706, 'Started', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9706, 'Waiting', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  UPDATE public.players SET nba_team = 'QQ' WHERE id = p1;
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029706001', 9706, 1, (now() AT TIME ZONE 'America/New_York')::date,
      'QQ', 'QO', 'InProgress', now() - interval '1 hour');
  PERFORM pg_temp.check_rules(public.process_roster_floor_service(f.league_id, f.season_id)->>'reason' = 'game_in_progress',
    'a live game defers the floor');
  UPDATE public.nba_games SET status = 'Final' WHERE nba_game_id = '0029706001';
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the floor awards the available player');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'a started game keeps its player out of the pool');
END;
$$;

DO $$
DECLARE f record; p1 uuid; v_ready jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9707, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9707, 'One', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, status)
    VALUES(f.league_id, f.season_id, 1, f.week_end - 1, 'completed');
  v_ready := private.roster_floor_week_ready(f.league_id, f.season_id, 1, f.week_end - 1);
  PERFORM pg_temp.check_rules(v_ready->>'reason' = 'week_ended', 'a past week is closed');
  DELETE FROM private.roster_floor_weeks WHERE league_id = f.league_id AND week_number = 1;
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((SELECT status = 'completed' FROM private.roster_floor_weeks
    WHERE league_id = f.league_id), 'the week completes');
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id), 'a completed week is never re-opened');
END;
$$;

DO $$
DECLARE f record; v_ir uuid; p1 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9708, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_ir := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_ir, v_ir::text, 'Healthy', 'IR', 'PG', ARRAY['PG'], 'Healthy', 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_ir, 'draft', true);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9708, 'Unused', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.roster_players
    WHERE league_id = f.league_id AND player_id = v_ir AND is_on_ir), 'the healthy IR player returns before counting');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16,
    'the returned player fills the floor');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id),
    'no free agent is added');
END;
$$;

DO $$
DECLARE f record; v_ir1 uuid; v_ir2 uuid; p1 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9709, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_ir1 := gen_random_uuid(); v_ir2 := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_ir1, v_ir1::text, 'Out1', 'IR', 'PG', ARRAY['PG'], 'Out', 'ZZ'),
          (v_ir2, v_ir2::text, 'Out2', 'IR', 'PG', ARRAY['PG'], 'Out', 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_ir1, 'draft', true),
          (f.league_id, f.season_id, f.member_ids[1], v_ir2, 'draft', true);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9709, 'Fill', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.roster_players
    WHERE league_id = f.league_id AND is_on_ir), 'a full injured IR changes nothing');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16,
    'the floor still fills the active roster');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid; v_trade uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9710, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9710, 'Reserved', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9710, 'Free', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  INSERT INTO public.trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id, status)
    VALUES(gen_random_uuid(), f.league_id, f.season_id, f.member_ids[2], f.member_ids[1], 'pending')
    RETURNING id INTO v_trade;
  INSERT INTO public.trade_items(trade_id, side, player_id, from_member_id, to_member_id, faab_amount, league_id)
    VALUES(v_trade, 'proposer', p1, f.member_ids[2], f.member_ids[1], 0, f.league_id);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the floor awards the free player');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'a trade-reserved player is not awarded');
END;
$$;

DO $$
DECLARE f record; p1 uuid; v_trade uuid; v_in1 uuid; v_in2 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9711, 2, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9711, 'Blocked', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  v_in1 := gen_random_uuid(); v_in2 := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_in1, v_in1::text, 'Incoming1', 'Test', 'PG', ARRAY['PG'], 'Healthy', 'ZZ'),
          (v_in2, v_in2::text, 'Incoming2', 'Test', 'PG', ARRAY['PG'], 'Healthy', 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[2], v_in1, 'draft'),
          (f.league_id, f.season_id, f.member_ids[2], v_in2, 'draft');
  INSERT INTO public.trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id, status)
    VALUES(gen_random_uuid(), f.league_id, f.season_id, f.member_ids[2], f.member_ids[1], 'accepted')
    RETURNING id INTO v_trade;
  INSERT INTO public.trade_participants(trade_id, member_id, league_id, accepted_at)
    VALUES(v_trade, f.member_ids[1], f.league_id, now()), (v_trade, f.member_ids[2], f.league_id, now());
  INSERT INTO public.trade_items(trade_id, side, player_id, from_member_id, to_member_id, faab_amount, league_id)
    VALUES(v_trade, 'proposer', v_in1, f.member_ids[2], f.member_ids[1], 0, f.league_id),
          (v_trade, 'proposer', v_in2, f.member_ids[2], f.member_ids[1], 0, f.league_id);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 14,
    'accepted-trade capacity blocks the add');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id),
    'no award bypasses accepted-trade capacity');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9712, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9712, 'TieA', 25, NULL, '00000000-0000-4000-8000-000000000001');
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9712, 'TieB', 25, NULL, '00000000-0000-4000-8000-000000000002');
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p1), 'the lower player id wins a scoring tie');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p2), 'the tied player waits');
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9717, 4, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[4], 15);
  p1 := pg_temp.floor_no_stats_player('NoStats');
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9717, 'NoTeam', 50, NULL, NULL, NULL);
  p3 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9717, 'Questionable', 40, 'Questionable');
  p4 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9717, 'Out', 30, 'Out');
  p5 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9717, 'Healthy', 20);
  p6 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9717, 'Healthy2', 10);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2, p3, p4, p5, p6]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id IN (p1, p2, p3, p4)),
    'no-stats, teamless, questionable and out players are never awarded');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p5), 'the best healthy player on an NBA team is awarded');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards
    WHERE league_id = f.league_id AND player_id = p6), 'the next healthy player is awarded');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM private.roster_floor_awards
    WHERE league_id = f.league_id), 'the ineligible players leave the pool exhausted');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.roster_players
    WHERE league_id = f.league_id AND acquired_via = 'roster_floor'), 'only two adds happen');
END;
$$;

DO $$
DECLARE f record; p1 uuid; v_before text; v_after text;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9713, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9713, 'Fill', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  INSERT INTO public.faab_balances(league_id, league_season_id, member_id, balance)
    VALUES(f.league_id, f.season_id, f.member_ids[1], 100), (f.league_id, f.season_id, f.member_ids[2], 50)
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET balance = EXCLUDED.balance;
  INSERT INTO public.weekly_add_counts(league_id, league_season_id, member_id, week_number, add_count)
    VALUES(f.league_id, f.season_id, f.member_ids[1], 1, 2)
    ON CONFLICT (league_id, league_season_id, member_id, week_number) DO UPDATE SET add_count = EXCLUDED.add_count;
  SELECT md5(string_agg(x, '|' ORDER BY x)) INTO v_before FROM (
    SELECT 'faab:' || member_id || ':' || balance AS x FROM public.faab_balances WHERE league_id = f.league_id
    UNION ALL SELECT 'priority:' || member_id || ':' || priority FROM public.waiver_priorities WHERE league_id = f.league_id
    UNION ALL SELECT 'adds:' || member_id || ':' || week_number || ':' || add_count FROM public.weekly_add_counts WHERE league_id = f.league_id
    UNION ALL SELECT 'claims:' || id || ':' || status FROM public.waiver_claims WHERE league_id = f.league_id
  ) rows;
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT md5(string_agg(x, '|' ORDER BY x)) INTO v_after FROM (
    SELECT 'faab:' || member_id || ':' || balance AS x FROM public.faab_balances WHERE league_id = f.league_id
    UNION ALL SELECT 'priority:' || member_id || ':' || priority FROM public.waiver_priorities WHERE league_id = f.league_id
    UNION ALL SELECT 'adds:' || member_id || ':' || week_number || ':' || add_count FROM public.weekly_add_counts WHERE league_id = f.league_id
    UNION ALL SELECT 'claims:' || id || ':' || status FROM public.waiver_claims WHERE league_id = f.league_id
  ) rows;
  PERFORM pg_temp.check_rules(v_before = v_after, 'FAAB, priority, add counts and claims are unchanged');
END;
$$;

DO $$
DECLARE f record; p1 uuid; v_player uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9714, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9714, 'Fill', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  SELECT player_id INTO v_player FROM public.roster_players
   WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND NOT is_on_ir AND NOT is_on_taxi LIMIT 1;
  DELETE FROM public.roster_players
   WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_player;
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 15,
    'a drop after the run triggers no refill');
END;
$$;

DO $$
DECLARE f record; c record; p1 uuid; v_before int;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9715, 2, 16, 20);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9715, 'Fill', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  SELECT * INTO c FROM pg_temp.rules_fixture(1, 9716);
  PERFORM pg_temp.floor_roster(c.league_id, c.season_id, c.member_ids[1], 15);
  SELECT count(*) INTO v_before FROM public.roster_players WHERE league_id = c.league_id;
  PERFORM public.process_roster_floor_service();
  PERFORM pg_temp.check_rules((SELECT count(*) = v_before FROM public.roster_players WHERE league_id = c.league_id),
    'a league without a floor policy is untouched');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_weeks WHERE league_id = c.league_id),
    'the control league has no week record');
END;
$$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
