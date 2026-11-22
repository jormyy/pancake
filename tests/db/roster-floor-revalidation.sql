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
  IF to_regclass('private.waiver_run_settlements') IS NOT NULL THEN
    INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
      VALUES(f.league_id, f.season_id, v_end);
  END IF;
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

CREATE FUNCTION pg_temp.floor_free_agent(p_league uuid, p_season uuid, p_year int, p_name text, p_avg numeric, p_team text DEFAULT 'ZZ')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, v_player::text, p_name, 'Test', 'PG', ARRAY['PG'], NULL, p_team);
  INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
    VALUES(p_league, p_season, p_year, v_player, '{}'::jsonb, p_avg, 1);
  RETURN v_player;
END;
$$;

CREATE TABLE pg_temp.revalidation_case(case_name text, top_player uuid, league uuid, season uuid, member uuid);
CREATE FUNCTION pg_temp.revalidation_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM pg_temp.revalidation_case LIMIT 1;
  IF c.case_name IS NULL OR NEW.player_id <> c.top_player THEN RETURN NEW; END IF;
  IF c.case_name = 'injury' THEN
    UPDATE public.players SET injury_status='Out' WHERE id=NEW.player_id;
  ELSIF c.case_name = 'claim' THEN
    INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date)
      VALUES(c.league, c.season, c.member, NEW.player_id, 1, (now() AT TIME ZONE 'America/New_York')::date);
  ELSIF c.case_name = 'tipoff' THEN
    UPDATE public.nba_games SET game_time = now() - interval '1 hour', status='InProgress'
      WHERE home_team = (SELECT nba_team FROM public.players WHERE id=NEW.player_id)
         OR away_team = (SELECT nba_team FROM public.players WHERE id=NEW.player_id);
  END IF;
  RAISE EXCEPTION 'revalidation scratch' USING ERRCODE='PT409';
END;
$$;
CREATE TRIGGER revalidation_scratch BEFORE INSERT ON public.roster_players
  FOR EACH ROW EXECUTE FUNCTION pg_temp.revalidation_trigger();

DO $$
DECLARE f record; v_top uuid; v_next uuid; v_result jsonb; v_case text;
BEGIN
  FOREACH v_case IN ARRAY ARRAY['injury', 'claim', 'tipoff'] LOOP
    SELECT * INTO f FROM pg_temp.floor_league(9810, 2, 16);
    PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
    PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
    v_top := pg_temp.floor_free_agent(f.league_id, f.season_id, 9810, 'Top', 40, 'QQ');
    v_next := pg_temp.floor_free_agent(f.league_id, f.season_id, 9810, 'Next', 30, 'RR');
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
      VALUES(gen_random_uuid(), '0029810' || v_case, 9810, 1, (now() AT TIME ZONE 'America/New_York')::date, 'QQ', 'QO', 'Scheduled', now() + interval '4 hours');
    DELETE FROM pg_temp.revalidation_case;
    INSERT INTO pg_temp.revalidation_case VALUES(v_case, v_top, f.league_id, f.season_id, f.member_ids[1]);
    v_result := public.process_roster_floor_service(f.league_id, f.season_id);
    IF NOT EXISTS (SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND player_id = v_next) THEN
      RAISE EXCEPTION 'case % did not award the next legal player: %', v_case, v_result;
    END IF;
    IF EXISTS (SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND player_id = v_top) THEN
      RAISE EXCEPTION 'case % awarded the ineligible top player', v_case;
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE f record; v_player uuid; v_result jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9811, 2, 16);
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9811, 1, (now() AT TIME ZONE 'America/New_York')::date - 6, (now() AT TIME ZONE 'America/New_York')::date)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key
    DO UPDATE SET week_end=EXCLUDED.week_end;
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_player := pg_temp.floor_free_agent(f.league_id, f.season_id, 9811, 'Postponed', 40, 'PP');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_status_text, game_time)
    VALUES(gen_random_uuid(), '0029811001', 9811, 1, (now() AT TIME ZONE 'America/New_York')::date, 'PP', 'PO', 'Scheduled', 'Postponed', now() - interval '1 hour');
  RAISE NOTICE 'debug weeks=% matchups=% season=% week_end=% today=%', (SELECT count(*) FROM public.season_weeks WHERE season_year=9811), (SELECT count(*) FROM public.matchups WHERE league_id=f.league_id), f.season_id, (SELECT week_end FROM public.season_weeks WHERE season_year=9811), (now() AT TIME ZONE 'America/New_York')::date;
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  IF (v_result->>'reason') = 'game_in_progress' THEN
    RAISE EXCEPTION 'a Postponed game blocked the floor: %', v_result;
  END IF;
  SELECT * INTO f FROM pg_temp.floor_league(9812, 2, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_player := pg_temp.floor_free_agent(f.league_id, f.season_id, 9812, 'Stale', 40, 'PP');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_status_text, game_time)
    VALUES(gen_random_uuid(), '0029812001', 9812, 1, (now() AT TIME ZONE 'America/New_York')::date, 'PP', 'PO', 'Scheduled', NULL, now() - interval '1 hour');
  v_result := public.process_roster_floor_service(f.league_id, f.season_id);
  IF (v_result->>'reason') IS DISTINCT FROM 'game_in_progress' THEN
    RAISE EXCEPTION 'a stale Scheduled game did not block the floor: %', v_result;
  END IF;
END;
$$;
ROLLBACK;
