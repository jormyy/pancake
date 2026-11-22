\ir rules-support.sql
DO $$
DECLARE f record; v_ir uuid; v_game_time timestamptz := now() + interval '5 seconds'; i int; y int;
BEGIN
  FOREACH y IN ARRAY ARRAY[9930, 9931] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2, y);
    UPDATE public.leagues SET roster_size=20, ir_slots=1, timezone='Pacific/Kiritimati' WHERE id=f.league_id;
    INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
      VALUES(f.league_id, 16, true, now(), now());
    INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
      VALUES(y, 1, (now() AT TIME ZONE 'America/New_York')::date - 6, (now() AT TIME ZONE 'America/New_York')::date);
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
      VALUES(f.league_id, f.season_id, 1, f.member_ids[1], f.member_ids[2]);
    INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
      VALUES(f.league_id, f.season_id, (now() AT TIME ZONE 'America/New_York')::date);
    FOR i IN 1..15 LOOP
      INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
        VALUES(gen_random_uuid(), gen_random_uuid()::text, 'Roster', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
    END LOOP;
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      SELECT f.league_id, f.season_id, f.member_ids[1], p.id, 'draft'
        FROM public.players p WHERE p.nba_team='ZZ' AND p.first_name='Roster' LIMIT 15;
    v_ir := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_ir, v_ir::text, 'IR', 'Test', 'PG', ARRAY['PG'], NULL, 'QQ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
      VALUES(f.league_id, f.season_id, f.member_ids[1], v_ir, 'draft', true);
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
      VALUES(gen_random_uuid(), '002' || y || '001', y, 1, (now() AT TIME ZONE 'America/New_York')::date, 'QQ', 'QO', 'Scheduled', v_game_time);
    RAISE NOTICE 'IDS %|%|%|%', f.league_id, f.season_id, f.member_ids[1], v_ir;
  END LOOP;
END;
$$;
