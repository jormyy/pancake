BEGIN;
\ir rules-support.sql
UPDATE public.nba_games SET status='Final' WHERE status='InProgress';

CREATE FUNCTION pg_temp.floor_league(p_year int, p_teams int, p_floor int)
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], week_number int, week_end date)
LANGUAGE plpgsql AS $$
DECLARE f record; v_end date := (now() AT TIME ZONE 'America/New_York')::date; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=20, timezone='Pacific/Kiritimati' WHERE id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members)
    VALUES(f.league_id, p_floor, true);
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='private' AND table_name='league_roster_policies' AND column_name='floor_activated_at') THEN
    UPDATE private.league_roster_policies SET floor_activated_at = now(), ir_activated_at = now()
     WHERE private.league_roster_policies.league_id = f.league_id;
  END IF;
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
    SELECT f.league_id, f.season_id, true, league.scoring_settings
      FROM public.leagues league WHERE league.id = f.league_id
    ON CONFLICT (league_season_id) DO UPDATE
      SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring;
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

CREATE FUNCTION pg_temp.floor_roster(p_league uuid, p_season uuid, p_member uuid, p_count int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int; v_player uuid;
BEGIN
  FOR i IN 1..p_count LOOP
    v_player := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_player, v_player::text, 'Roster', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES(p_league, p_season, p_member, v_player, 'draft');
  END LOOP;
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

DO $$
DECLARE f record; v_result jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9801, 2, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_free_agent(f.league_id, f.season_id, 9801, 'Free', 40);
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  IF (v_result->>'status') = 'completed' AND COALESCE((v_result->>'awarded')::int, 0) > 0 THEN
    RAISE EXCEPTION 'the floor ran without a settled waiver run: %', v_result;
  END IF;
  IF (v_result->>'reason') IS DISTINCT FROM 'settlement_pending' THEN
    RAISE EXCEPTION 'expected settlement_pending, got %', v_result;
  END IF;
END;
$$;

DO $$
DECLARE f record; v_count int; v_date date := (now() AT TIME ZONE 'America/New_York')::date; v_player uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9820, 2, 16);
  v_player := pg_temp.floor_free_agent(f.league_id, f.season_id, 9820, 'Settle', 40);
  v_count := private.settle_waiver_runs('Pacific/Kiritimati', v_date, (v_date + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  IF NOT EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date) THEN
    RAISE EXCEPTION 'zero claims did not settle';
  END IF;
  v_count := private.settle_waiver_runs('Pacific/Kiritimati', v_date, (v_date + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  IF (SELECT count(*) FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date) <> 1 THEN
    RAISE EXCEPTION 'retry duplicated settlement';
  END IF;
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_player, 1, v_date + 1);
  DELETE FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date;
  v_count := private.settle_waiver_runs('Pacific/Kiritimati', v_date, (v_date + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  IF NOT EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date) THEN
    RAISE EXCEPTION 'a Monday claim blocked Sunday settlement';
  END IF;
  DELETE FROM public.waiver_claims WHERE league_id=f.league_id AND player_id=v_player;
  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, clears_at)
    VALUES(f.league_id, f.season_id, v_player, (v_date + 2 + time '00:00') AT TIME ZONE 'Pacific/Kiritimati');
  DELETE FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date;
  v_count := private.settle_waiver_runs('Pacific/Kiritimati', v_date, (v_date + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  IF NOT EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date) THEN
    RAISE EXCEPTION 'a Tuesday-clearing hold blocked Sunday settlement';
  END IF;
  DELETE FROM public.waiver_wire_log WHERE league_id=f.league_id AND player_id=v_player;
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_player, 1, v_date);
  DELETE FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date;
  v_count := private.settle_waiver_runs('Pacific/Kiritimati', v_date, (v_date + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  IF EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date) THEN
    RAISE EXCEPTION 'a Sunday-due claim did not block settlement';
  END IF;
  DELETE FROM public.waiver_claims WHERE league_id=f.league_id AND player_id=v_player;
  v_count := private.settle_waiver_runs('Pacific/Kiritimati', v_date, (v_date + time '01:00') AT TIME ZONE 'Pacific/Kiritimati');
  IF NOT EXISTS (SELECT 1 FROM private.waiver_run_settlements WHERE league_id=f.league_id AND process_date=v_date) THEN
    RAISE EXCEPTION 'settlement did not record after the claim resolved';
  END IF;
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  IF NOT EXISTS (SELECT 1 FROM private.roster_floor_awards WHERE league_id=f.league_id AND player_id=v_player) THEN
    RAISE EXCEPTION 'the floor did not run after settlement';
  END IF;
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  IF (SELECT count(*) FROM private.roster_floor_awards WHERE league_id=f.league_id AND player_id=v_player) <> 1 THEN
    RAISE EXCEPTION 'a completed week refilled';
  END IF;
END;
$$;
ROLLBACK;
