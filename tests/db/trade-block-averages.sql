BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  fixture record;
  player uuid := gen_random_uuid();
  game uuid;
  year integer := public.current_season_year_et();
  result jsonb;
  asset jsonb;
  phase integer;
  points integer;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2, year);
  UPDATE public.leagues SET scoring_settings = '{"points":1}' WHERE id = fixture.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    VALUES(player, 'Averages', 'Listing', 'PG', ARRAY['PG']);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(fixture.league_id, fixture.season_id, fixture.member_ids[2], player, 'draft');
  FOREACH points IN ARRAY ARRAY[35,37,40] LOOP
    game := gen_random_uuid();
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
      VALUES(game, '002' || replace(game::text, '-', ''), year, 1, current_date, 'BOS', 'MEM', 'Final');
    INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number, points, minutes_played, did_not_play)
      VALUES(player, game, year, 1, points, 24.7, false);
  END LOOP;
  PERFORM public.add_trade_block_item_atomic(fixture.member_ids[2], fixture.league_id, player, NULL, NULL, fixture.user_ids[2]);
  PERFORM set_config('request.jwt.claim.sub', fixture.user_ids[1]::text, true);
  FOR phase IN 1..2 LOOP
    result := public.view_trade_block(fixture.league_id, fixture.member_ids[1]);
    SELECT item->'asset' INTO STRICT asset FROM jsonb_array_elements(result->'items') item
      WHERE item->'asset'->>'playerId' = player::text;
    PERFORM pg_temp.check_rules((asset->>'avgFantasyPoints')::numeric = 37.33,
      'Current-season fantasy average survives phase ' || phase);
    PERFORM pg_temp.check_rules((asset->>'avgMinutesPlayed')::numeric = 24.7,
      'Current-season minutes survive phase ' || phase);
    PERFORM pg_temp.check_rules(NOT (result->'avgMap' ? player::text),
      'Another team listing stays outside viewer roster phase ' || phase);
    IF phase = 1 THEN
      INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
        SELECT fixture.league_id, fixture.season_id, year, player, to_jsonb(average), 37.33, 1
        FROM public.mv_player_season_averages average WHERE player_id = player AND season_year = year;
    END IF;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
