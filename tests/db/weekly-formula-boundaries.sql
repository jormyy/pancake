BEGIN;
SET LOCAL statement_timeout = '60s';
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_game uuid := gen_random_uuid();
  v_player uuid := gen_random_uuid();
  v_stat uuid := gen_random_uuid();
  v_key text;
  v_value numeric;
BEGIN
  INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    VALUES(v_user, 'authenticated', 'authenticated', v_user || '@example.test', '{}', '{}');
  INSERT INTO leagues(id, name, slug, commissioner_id, scoring_settings)
    VALUES(v_league, 'Synthetic formula', v_league::text, v_user, '{}');
  INSERT INTO players(id, first_name, last_name) VALUES(v_player, 'Synthetic', v_player::text);
  INSERT INTO nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES(v_game, '002-formula-' || v_game, 8994, 1, '2099-01-01', 'XXA', 'XXB', 'InProgress');
  INSERT INTO player_game_stats(id, player_id, game_id, season_year, week_number, points, rebounds,
    assists, steals, blocks, turnovers, three_pointers_made, field_goals_made, field_goals_attempted,
    free_throws_made, free_throws_attempted, double_double, triple_double, did_not_play)
    VALUES(v_stat, v_player, v_game, 8994, 1, 17, 7, 5, 3, 2, 4, 6, 8, 11, 9, 13, true, true, false);
  FOR v_key, v_value IN SELECT * FROM (VALUES
    ('points', 17), ('rebounds', 7), ('assists', 5), ('steals', 3), ('blocks', 2), ('turnovers', 4),
    ('three_pointers_made', 6), ('field_goals_made', 8), ('field_goals_attempted', 11),
    ('free_throws_made', 9), ('free_throws_attempted', 13), ('double_double', 1), ('triple_double', 1)
  ) valueset(key, value) LOOP
    UPDATE leagues SET scoring_settings = jsonb_build_object(v_key, -1.25) WHERE id = v_league;
    IF compute_fantasy_points(v_stat, v_league) IS DISTINCT FROM v_value * -1.25 THEN
      RAISE EXCEPTION 'Scoring weight for % does not match its stat', v_key;
    END IF;
  END LOOP;
  UPDATE leagues SET scoring_settings = '{"points":1}' WHERE id = v_league;
  UPDATE player_game_stats SET did_not_play = true WHERE id = v_stat;
  IF compute_fantasy_points(v_stat, v_league) <> 0 THEN RAISE EXCEPTION 'DNP earns points'; END IF;
  UPDATE player_game_stats SET did_not_play = false WHERE id = v_stat;
  UPDATE nba_games SET nba_game_id = '001-formula-' || v_game WHERE id = v_game;
  IF compute_fantasy_points(v_stat, v_league) <> 0 THEN RAISE EXCEPTION 'Preseason earns points'; END IF;
END;
$$;
ROLLBACK;
SELECT 'weekly formula boundaries: PASS';
