BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  scenario record;
  season uuid;
  draft uuid;
  expected uuid;
BEGIN
  FOR scenario IN SELECT * FROM (VALUES
    ('unequal games', 2, 2, 0, 400, 3, 4, 0, 700, 2),
    ('half-win ties', 2, 1, 1, 400, 2, 1, 0, 300, 1),
    ('points per game', 2, 1, 0, 300, 4, 2, 0, 300, 2),
    ('no games', 0, 0, 0, 0, 1, 1, 0, 200, 1)
  ) cases(label, a_wins, a_losses, a_ties, a_points, b_wins, b_losses, b_ties, b_points, first_team) LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2, 9392, 'playoffs');
    INSERT INTO public.standings(league_id, league_season_id, member_id, week_number, wins, losses, ties, points_for, waiver_priority)
    VALUES(f.league_id, f.season_id, f.member_ids[1], 1, scenario.a_wins, scenario.a_losses, scenario.a_ties, scenario.a_points, 1),
      (f.league_id, f.season_id, f.member_ids[2], 1, scenario.b_wins, scenario.b_losses, scenario.b_ties, scenario.b_points, 2);
    expected := f.member_ids[scenario.first_team];
    SELECT new_season_id INTO season FROM public.advance_season_atomic(f.league_id);
    PERFORM pg_temp.check_rules((SELECT member_id = expected FROM public.waiver_priorities
      WHERE league_season_id = season AND priority = 1), 'next-season waiver priority uses ' || scenario.label);
    draft := (public.start_rookie_draft_atomic(f.league_id, 1, true)->>'id')::uuid;
    PERFORM pg_temp.check_rules((SELECT member_id = expected FROM public.draft_orders
      WHERE draft_id = draft AND position = 1), 'rookie draft order uses ' || scenario.label);
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
