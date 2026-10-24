BEGIN;
\ir rules-support.sql

DO $$
DECLARE
  v_fixture record;
  v_case record;
  v_first record;
  v_second record;
BEGIN
  SELECT * INTO v_fixture FROM pg_temp.rules_fixture(5, 9376);
  FOR v_case IN SELECT * FROM (VALUES
    ('win percentage', 2, 2, 0, 100, 0, 0, 4, 3, 0, 125, 0, 0),
    ('half-win ties', 2, 1, 1, 100, 0, 0, 2, 1, 0, 250, 0, 0),
    ('points per game', 2, 1, 0, 110, 0, 0, 4, 2, 0, 100, 0, 0),
    ('maximum points', 2, 1, 0, 100, 250, 0, 4, 2, 0, 100, 100, 0),
    ('points against', 2, 1, 0, 100, 0, 50, 4, 2, 0, 100, 0, 50),
    ('equal rates', 2, 1, 0, 100, 0, 0, 4, 2, 0, 100, 0, 0)
  ) cases(label, a_games, a_wins, a_ties, a_points, a_max, a_against,
    b_games, b_wins, b_ties, b_points, b_max, b_against) LOOP
    DELETE FROM public.matchups WHERE league_season_id = v_fixture.season_id;
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id,
      matchup_type, home_points, away_points, home_max_possible_points, away_max_possible_points,
      is_finalized, winner_member_id)
    SELECT v_fixture.league_id, v_fixture.season_id, week, v_fixture.member_ids[1], v_fixture.member_ids[3],
      'regular_season'::public.matchup_type, v_case.a_points, v_case.a_against, v_case.a_max, 0, true,
      CASE WHEN week <= v_case.a_wins THEN v_fixture.member_ids[1]
        WHEN week <= v_case.a_wins + v_case.a_ties THEN NULL ELSE v_fixture.member_ids[3] END
    FROM generate_series(1, v_case.a_games) week
    UNION ALL
    SELECT v_fixture.league_id, v_fixture.season_id, week, v_fixture.member_ids[2], v_fixture.member_ids[4],
      'regular_season'::public.matchup_type, v_case.b_points, v_case.b_against, v_case.b_max, 0, true,
      CASE WHEN week <= v_case.b_wins THEN v_fixture.member_ids[2]
        WHEN week <= v_case.b_wins + v_case.b_ties THEN NULL ELSE v_fixture.member_ids[4] END
    FROM generate_series(1, v_case.b_games) week;
    SELECT * INTO v_first FROM private.playoff_seed_rankings(v_fixture.league_id, v_fixture.season_id, 5)
    WHERE member_id = v_fixture.member_ids[1];
    SELECT * INTO v_second FROM private.playoff_seed_rankings(v_fixture.league_id, v_fixture.season_id, 5)
    WHERE member_id = v_fixture.member_ids[2];
    IF v_case.label = 'equal rates' THEN
      PERFORM pg_temp.check_rules(v_first.group_start = v_second.group_start,
        'equal rates with unequal games share the same tie group');
    ELSE
      PERFORM pg_temp.check_rules(v_first.seed_rank < v_second.seed_rank,
        'SQL seeding uses ' || v_case.label);
      PERFORM pg_temp.check_rules(v_first.group_start <> v_second.group_start,
        'SQL tie groups respect ' || v_case.label);
    END IF;
    PERFORM pg_temp.check_rules((SELECT count(*) = 5 AND count(DISTINCT seed_rank) = 5
      FROM private.playoff_seed_rankings(v_fixture.league_id, v_fixture.season_id, 5)),
      'SQL seeding handles no games: ' || v_case.label);
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
