BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  fixture record;
  result jsonb;
  saved_ids uuid[];
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(4, 9481);
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
  SELECT 9481, week, date '9481-02-01' + (week - 1) * 7, date '9481-02-07' + (week - 1) * 7
  FROM generate_series(1, 5) week;
  UPDATE public.leagues SET playoff_start_week = 4 WHERE id = fixture.league_id;
  result := public.replace_regular_season_matchups_atomic(
    p_league_id => fixture.league_id, p_league_season_id => fixture.season_id,
    p_force => false, p_matchups => '[]'::jsonb);
  PERFORM pg_temp.check_rules((result->>'inserted')::int = 6, 'empty Edge payload generates all regular matchups');
  PERFORM pg_temp.check_rules((SELECT count(*) = 6 AND count(DISTINCT week_number) = 3
    FROM public.matchups WHERE league_season_id = fixture.season_id), 'schedule uses saved playoff start and member count');
  SELECT array_agg(id ORDER BY id) INTO saved_ids FROM public.matchups WHERE league_season_id = fixture.season_id;
  result := public.replace_regular_season_matchups_atomic(fixture.league_id, fixture.season_id, false, '[]'::jsonb);
  PERFORM pg_temp.check_rules(result = '{"inserted":0,"skipped":true}'::jsonb, 'existing schedule skips the empty Edge payload');
  PERFORM pg_temp.check_rules((SELECT array_agg(id ORDER BY id) = saved_ids FROM public.matchups
    WHERE league_season_id = fixture.season_id), 'existing schedule keeps its matchup identities');
  result := public.replace_regular_season_matchups_atomic(fixture.league_id, fixture.season_id, true, '[]'::jsonb);
  PERFORM pg_temp.check_rules(result = '{"inserted":6,"skipped":false}'::jsonb,
    'force rebuilds the future schedule from the empty Edge payload');
  PERFORM pg_temp.check_rules((SELECT NOT array_agg(id ORDER BY id) && saved_ids FROM public.matchups
    WHERE league_season_id = fixture.season_id), 'force replaces every existing matchup identity');
  SELECT array_agg(id ORDER BY id) INTO saved_ids FROM public.matchups WHERE league_season_id=fixture.season_id;
  UPDATE public.matchups SET is_finalized = true WHERE league_season_id = fixture.season_id;
  PERFORM pg_temp.reject_rules(format('SELECT public.replace_regular_season_matchups_atomic(%L,%L,true,%L)',
    fixture.league_id,fixture.season_id,'[]'),
    'The season has started; the schedule can no longer be rebuilt.','force refuses finalized schedules');
  PERFORM pg_temp.check_rules((SELECT array_agg(id ORDER BY id)=saved_ids FROM public.matchups
    WHERE league_season_id=fixture.season_id),'refused reset preserves finalized matchup identities');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
