BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE schedule_links AS SELECT * FROM pg_temp.rules_fixture(2, 9585);
DO $$
DECLARE f record; matchup uuid := gen_random_uuid(); result jsonb;
BEGIN
  SELECT * INTO f FROM schedule_links;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    SELECT 9585, week, current_date + (week - 1) * 7, current_date + week * 7 - 1 FROM generate_series(1, 4) week;
  UPDATE public.league_seasons SET playoff_start_week = 3, playoff_round_weeks = ARRAY[2] WHERE id = f.season_id;
  INSERT INTO public.matchups(id, league_id, league_season_id, week_number, end_week_number, home_member_id, away_member_id, matchup_type)
    VALUES(matchup, f.league_id, f.season_id, 3, 4, f.member_ids[1], f.member_ids[2], 'playoff_final');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  result := public.view_league_schedule(f.league_id, f.member_ids[1])->'schedule';
  PERFORM pg_temp.check_rules(result->0->'matchupId' = 'null'::jsonb, 'placeholder has no matchup destination');
  PERFORM pg_temp.check_rules(result->2->>'matchupId' = matchup::text AND result->3->>'matchupId' = matchup::text, 'both playoff weeks open the same matchup');
  UPDATE public.league_seasons SET skipped_weeks = ARRAY[3] WHERE id = f.season_id;
  result := public.view_league_schedule(f.league_id, f.member_ids[1])->'schedule';
  PERFORM pg_temp.check_rules(result->2->'matchupId' = 'null'::jsonb, 'skipped week has no matchup destination');
  UPDATE public.matchups SET is_voided = true WHERE id = matchup;
  result := public.view_league_schedule(f.league_id, f.member_ids[1])->'schedule';
  PERFORM pg_temp.check_rules(result->3->'matchupId' = 'null'::jsonb, 'voided matchup has no destination');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
