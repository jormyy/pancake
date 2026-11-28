BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  player uuid := gen_random_uuid();
  bench uuid := gen_random_uuid();
  regular_game uuid := gen_random_uuid();
  late_game uuid := gen_random_uuid();
  preseason_game uuid := gen_random_uuid();
  stat_ids uuid[];
  checked integer;
  mismatches integer;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9568);
  UPDATE public.leagues SET scoring_settings = '{"points":1.1,"rebounds":1.25,"assists":1.5,"steals":3,"blocks":3,"turnovers":-0.75,
    "three_pointers_made":0.5,"field_goals_made":0.33,"field_goals_attempted":-0.2,"free_throws_made":0.15,"free_throws_attempted":-0.05,
    "double_double":2.5,"triple_double":4.25}'::jsonb WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name) VALUES (player, 'Parity', 'Player'), (bench, 'Parity', 'Bench');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES (regular_game, '0029568001', 9568, 1, '9568-01-01', 'BOS', 'NYK', 'Final'),
      (late_game, '0029568002', 9568, 1, '9568-01-02', 'BOS', 'NYK', 'Final'),
      (preseason_game, '0019568001', 9568, 1, '9568-01-03', 'BOS', 'NYK', 'Final');
  INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number, game_date, points, rebounds, assists, steals, blocks,
    turnovers, three_pointers_made, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted,
    double_double, triple_double, did_not_play)
  VALUES (player, regular_game, 9568, 1, '9568-01-01', 27, 11, 10, 2, 1, 4, 3, 10, 19, 4, 5, true, true, false),
    (player, late_game, 9568, 1, '9568-01-02', 13, NULL, 2, NULL, 0, 1, NULL, 5, 11, 3, 3, false, false, false),
    (player, preseason_game, 9568, 1, '9568-01-03', 30, 10, 0, 0, 0, 0, 0, 12, 20, 6, 6, true, false, false),
    (bench, regular_game, 9568, 1, '9568-01-01', 4, 0, 0, 0, 0, 0, 0, 2, 3, 0, 0, false, false, true);
  SELECT array_agg(id) INTO stat_ids FROM public.player_game_stats WHERE player_id IN (player, bench);

  SELECT count(*), count(*) FILTER (WHERE COALESCE(scored.points, 0) IS DISTINCT FROM public.compute_fantasy_points(stat.id, f.league_id))
    INTO checked, mismatches
  FROM public.player_game_stats stat
  LEFT JOIN private.fantasy_points_rows(f.league_id, stat_ids) scored ON scored.stat_id = stat.id
  WHERE stat.id = ANY(stat_ids);
  PERFORM pg_temp.check_rules(checked = 4, 'every seeded stat row is compared');
  PERFORM pg_temp.check_rules(mismatches = 0, 'batched scores match compute_fantasy_points for every row');
  PERFORM pg_temp.check_rules((SELECT scored.points FROM private.fantasy_points_rows(f.league_id, stat_ids) scored
    JOIN public.player_game_stats stat ON stat.id = scored.stat_id WHERE stat.game_id = regular_game) = 72.55,
    'regular-season row includes every weight and both bonuses');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.fantasy_points_rows(f.league_id, stat_ids)) = 2,
    'preseason and did-not-play rows score nothing');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.fantasy_points_rows(gen_random_uuid(), stat_ids)),
    'an unknown league scores nothing');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated', 'private.fantasy_points_rows(uuid,uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'private.fantasy_points_rows(uuid,uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'private.fantasy_points_rows(uuid,uuid[])', 'EXECUTE'),
    'batched scorer is not executable by API roles');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
