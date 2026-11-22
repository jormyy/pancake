\set ON_ERROR_STOP on
\ir rules-support.sql
SET LOCAL statement_timeout = '180s';

CREATE FUNCTION pg_temp.r6_league(p_year int, p_teams int, p_floor int, p_week1_end date, p_week2_end date)
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], user_ids uuid[])
LANGUAGE plpgsql AS $$
DECLARE f record; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=20, ir_slots=1, timezone='Pacific/Kiritimati' WHERE id=f.league_id;
  UPDATE public.lineup_optimizer_settings s SET enabled=false, enabled_at=NULL WHERE s.league_id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
    VALUES(f.league_id, p_floor, false, now(), now());
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
    SELECT f.league_id, f.season_id, true, league.scoring_settings
      FROM public.leagues league WHERE league.id = f.league_id
    ON CONFLICT (league_season_id) DO UPDATE
      SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end) VALUES
    (p_year, 1, p_week1_end - 6, p_week1_end),
    (p_year, 2, p_week2_end - 6, p_week2_end)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
  UPDATE public.nba_games SET status='Final', game_time=now() - interval '1 hour'
   WHERE game_date IN (p_week1_end - 1, p_week1_end, p_week2_end - 1, p_week2_end,
     (now() AT TIME ZONE 'America/New_York')::date - 1, (now() AT TIME ZONE 'America/New_York')::date);
  FOR i IN 1..(p_teams / 2) LOOP
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id) VALUES
      (f.league_id, f.season_id, 1, f.member_ids[i * 2 - 1], f.member_ids[i * 2]),
      (f.league_id, f.season_id, 2, f.member_ids[i * 2 - 1], f.member_ids[i * 2]);
  END LOOP;
  league_id := f.league_id; season_id := f.season_id; member_ids := f.member_ids; user_ids := f.user_ids;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pg_temp.r6_roster(p_league uuid, p_season uuid, p_member uuid, p_count int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int; v_player uuid;
BEGIN
  FOR i IN 1..p_count LOOP
    v_player := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_player, v_player::text, 'Roster' || i, 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES(p_league, p_season, p_member, v_player, 'draft');
  END LOOP;
END;
$$;

CREATE FUNCTION pg_temp.r6_free_agent(p_league uuid, p_season uuid, p_year int, p_name text, p_avg numeric)
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

BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_result jsonb; v_status text; v_awards int;
BEGIN
  SELECT * INTO f FROM pg_temp.r6_league(9962, 2, 16, v_today - 7, v_today + 7);
  PERFORM pg_temp.r6_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.r6_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.r6_free_agent(f.league_id, f.season_id, 9962, 'Expired FA', 40);

  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'deferred' AND v_result->>'reason' = 'settlement_pending',
    'B: week 1 defers before the next week closes');
  UPDATE public.season_weeks SET week_start = v_today - 7, week_end = v_today - 1
   WHERE season_year = 9962 AND week_number = 2;
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
    VALUES(f.league_id, f.season_id, v_today - 1);
  v_result := private.run_league_roster_floor(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(v_result->>'status' = 'completed' AND (v_result->>'weekNumber')::int = 2,
    'B: the next week runs when the older week cannot finish');
  SELECT status INTO v_status FROM private.roster_floor_weeks
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.check_rules(v_status = 'expired',
    'B: the older week is expired with a terminal row');
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 1;
  PERFORM pg_temp.check_rules(v_awards = 0, 'B: the expired week never awards');
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND week_number = 2;
  PERFORM pg_temp.check_rules(v_awards = 1, 'B: the next week awards normally');
  RAISE NOTICE 'PASS r6-floor-retry-red';
END;
$$;
ROLLBACK;
