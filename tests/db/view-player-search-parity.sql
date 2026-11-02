BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()]; game uuid := gen_random_uuid();
  revision bigint; original jsonb; cached jsonb; sort_by text; direction text; health text; detected boolean := false;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, public.current_season_year_et());
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, nba_team, injury_status, years_exp)
    VALUES(players[1], 'Search', 'One', 'PG', ARRAY['PG'], 'VST', NULL, 0),
      (players[2], 'Search', 'Two', 'C', ARRAY['C'], 'OTH', 'Out', 4),
      (players[3], 'Search', 'DNP', 'SF', ARRAY['SF'], 'VST', 'GTD', 1);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES(game, '002screen-search', public.current_season_year_et(), 1, (now() AT TIME ZONE 'America/New_York')::date, 'VST', 'OTH', 'Final');
  INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number, points, rebounds, minutes_played, did_not_play)
    VALUES(players[1], game, public.current_season_year_et(), 1, 20, 5, 20, false),
      (players[2], game, public.current_season_year_et(), 1, 11, 10, 25, false),
      (players[3], game, public.current_season_year_et(), 1, 0, 0, 0, true);
  SELECT version INTO revision FROM private.screen_refresh_queue WHERE league_season_id = f.season_id;
  PERFORM private.refresh_player_averages(f.league_id, f.season_id, revision);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  FOREACH sort_by IN ARRAY ARRAY['fpts','min','pts','reb','ast','stl','blk','tpm','to','gp'] LOOP
    FOREACH direction IN ARRAY ARRAY['asc','desc'] LOOP
      FOREACH health IN ARRAY ARRAY['all','healthy','out','gtd'] LOOP
        SELECT COALESCE(jsonb_agg(to_jsonb(row)), '[]') INTO original FROM public.search_players(p_league_id := f.league_id,
          p_include_player_ids := players, p_sort_by := sort_by, p_sort_dir := direction, p_health := health) row;
        SELECT COALESCE(jsonb_agg(to_jsonb(row)), '[]') INTO cached FROM public.view_player_search(p_league_id := f.league_id,
          p_include_player_ids := players, p_sort_by := sort_by, p_sort_dir := direction, p_health := health) row;
        PERFORM pg_temp.check_rules(original = cached, format('cached search matches every field: %s %s %s', sort_by, direction, health));
      END LOOP;
    END LOOP;
  END LOOP;
  UPDATE public.player_season_averages SET averages = jsonb_set(averages, '{avg_points}', '999')
    WHERE league_id = f.league_id AND player_id = players[1];
  SELECT jsonb_agg(to_jsonb(row)) INTO original FROM public.search_players(p_league_id := f.league_id, p_include_player_ids := ARRAY[players[1]]) row;
  SELECT jsonb_agg(to_jsonb(row)) INTO cached FROM public.view_player_search(p_league_id := f.league_id, p_include_player_ids := ARRAY[players[1]]) row;
  BEGIN
    PERFORM pg_temp.check_rules(original = cached, 'negative control: changed player average');
  EXCEPTION WHEN raise_exception THEN detected := SQLERRM = 'FAIL: negative control: changed player average'; END;
  PERFORM pg_temp.check_rules(detected, 'parity assertion detects a deliberately corrupted cached average');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
