\set ON_ERROR_STOP on
\ir rules-support.sql
BEGIN;
DO $$
DECLARE
  f record;
  g record;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_p uuid := gen_random_uuid();
  v_floor_p uuid := gen_random_uuid();
  v_ir_p uuid := gen_random_uuid();
  v_roster uuid;
  v_b boolean;
  v_n int;
  v_j jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9910);
  UPDATE public.leagues SET roster_size = 20, ir_slots = 2 WHERE id = f.league_id;
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members)
    VALUES(f.league_id, true);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(v_p, 'R10', 'Ordinary', 'PG', ARRAY['PG'], 'Out', (v_today + 14)::text, 'QQ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_p, 'draft')
    RETURNING id INTO v_roster;
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    VALUES(gen_random_uuid(), '0029910001', 9910, 1, v_today, clock_timestamp() + interval '2 seconds', 'QQ', 'QR', 'Scheduled');

  v_b := private.roster_status_game_started(v_p);
  PERFORM pg_temp.check_rules(NOT v_b, 'A: the dormant-policy predicate is false before the tipoff');
  PERFORM pg_sleep(2.2);
  v_b := private.roster_status_game_started(v_p);
  PERFORM pg_temp.check_rules(NOT v_b, 'A: the dormant-policy predicate stays false after the tipoff');
  v_b := private.roster_status_game_started(v_p, clock_timestamp());
  PERFORM pg_temp.check_rules(v_b, 'A: the live predicate sees the crossed tipoff');
  PERFORM private.toggle_ir_for_activation(v_roster, true, f.user_ids[1], NULL);
  SELECT is_on_ir INTO v_b FROM public.roster_players WHERE id = v_roster;
  PERFORM pg_temp.check_rules(v_b, 'A: ordinary IR keeps the base predicate and moves the player');

  SELECT * INTO g FROM pg_temp.rules_fixture(2, 9911);
  UPDATE public.leagues SET roster_size = 20, ir_slots = 2 WHERE id = g.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
    VALUES(g.league_id, 16, true, now(), now());
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(v_floor_p, 'R10', 'Floor', 'PG', ARRAY['PG'], NULL, 'unknown', 'RR'),
      (v_ir_p, 'R10', 'Ir', 'PG', ARRAY['PG'], 'Out', (v_today + 14)::text, 'RR');
  INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
    VALUES(g.league_id, g.season_id, 9911, v_floor_p, '{}'::jsonb, 10, 1);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(g.league_id, g.season_id, g.member_ids[1], v_ir_p, 'draft');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    VALUES(gen_random_uuid(), '0029911001', 9911, 1, v_today, clock_timestamp() + interval '2 seconds', 'RR', 'RS', 'Scheduled');

  v_b := private.roster_floor_player_legal(g.league_id, g.season_id, v_floor_p);
  PERFORM pg_temp.check_rules(v_b, 'B: the floor player is legal before the tipoff');
  SELECT count(*) INTO v_n FROM private.roster_floor_pool(g.league_id, g.season_id) WHERE player_id = v_floor_p;
  PERFORM pg_temp.check_rules(v_n = 1, 'B: the floor pool lists the player before the tipoff');
  PERFORM pg_sleep(2.2);
  v_b := private.roster_floor_player_legal(g.league_id, g.season_id, v_floor_p);
  PERFORM pg_temp.check_rules(NOT v_b, 'B: the floor player is illegal after the tipoff');
  SELECT count(*) INTO v_n FROM private.roster_floor_pool(g.league_id, g.season_id) WHERE player_id = v_floor_p;
  PERFORM pg_temp.check_rules(v_n = 0, 'B: the floor pool drops the player after the tipoff');

  v_j := public.auto_manage_ir_service(g.league_id, g.season_id, g.member_ids[1]);
  SELECT is_on_ir INTO v_b FROM public.roster_players
   WHERE league_id = g.league_id AND member_id = g.member_ids[1] AND player_id = v_ir_p;
  PERFORM pg_temp.check_rules(NOT v_b, 'B: league-wide auto IR does not move the player after the tipoff');
  PERFORM pg_temp.check_rules(jsonb_array_length(v_j->'moves') = 0, 'B: league-wide auto IR reports no move after the tipoff');

  RAISE NOTICE 'PASS r10-lock-predicate';
END;
$$;
ROLLBACK;
