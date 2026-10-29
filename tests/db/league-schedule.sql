BEGIN;
SET LOCAL app.supabase_url = 'http://127.0.0.1:1';
SET LOCAL app.edge_internal_token = 'schedule-fixture';
\ir rules-support.sql
\set expected `cat tests/fixtures/league-schedule.json`
CREATE TEMP TABLE schedule_expected AS SELECT :'expected'::jsonb AS rows;
CREATE TEMP TABLE schedule_fixture AS SELECT * FROM pg_temp.rules_fixture(3, 9583);
GRANT SELECT ON schedule_fixture, schedule_expected TO authenticated;
DO $$
DECLARE f record; today date;
BEGIN
  SELECT * INTO f FROM schedule_fixture;
  today := (now() AT TIME ZONE 'Pacific/Kiritimati')::date;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    SELECT 9583, week, today + (week - 5) * 7, today + (week - 5) * 7 + 6 FROM generate_series(1, 20) week;
  UPDATE public.leagues SET timezone = 'Pacific/Kiritimati', playoff_start_week = 17, playoff_total_weeks = 4, playoff_round_weeks = ARRAY[2,2] WHERE id = f.league_id;
  UPDATE public.league_seasons SET playoff_start_week = 17, playoff_round_weeks = ARRAY[2,2] WHERE id = f.season_id;
  UPDATE public.league_members SET team_name = 'Cedar Owls' WHERE id = f.member_ids[2];
  INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id,
    home_points, away_points, is_finalized, winner_member_id)
    SELECT f.league_id, f.season_id, week,
      CASE WHEN week = 2 THEN f.member_ids[2] ELSE f.member_ids[1] END,
      CASE WHEN week = 2 THEN f.member_ids[1] ELSE f.member_ids[2] END,
      CASE week WHEN 1 THEN 531 WHEN 2 THEN 500 WHEN 3 THEN 300 WHEN 4 THEN 620 WHEN 5 THEN 112.5 ELSE 0 END,
      CASE week WHEN 1 THEN 465 WHEN 2 THEN 400 WHEN 3 THEN 300 WHEN 4 THEN 601 WHEN 5 THEN 90 ELSE 0 END,
      week < 5, CASE WHEN week IN (1,4) THEN f.member_ids[1] WHEN week = 2 THEN f.member_ids[2] END
    FROM generate_series(1, 16) week;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
END;
$$;
SET CONSTRAINTS private.league_version_commit IMMEDIATE;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; result jsonb; changed jsonb;
BEGIN
  SELECT * INTO f FROM schedule_fixture;
  result := public.view_league_schedule(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(result->'schedule' = (SELECT rows FROM schedule_expected), '20-week schedule matches JSON snapshot');
  PERFORM pg_temp.check_rules(octet_length(result::text) < 8192, '20-week payload stays under 8 KB');
  RAISE NOTICE 'Schedule payload: % bytes', octet_length(result::text);
  PERFORM pg_temp.check_rules((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(result) key) = ARRAY['context','schedule'], 'only context and schedule are returned');
  PERFORM pg_temp.check_rules(result->'context'->'league' = '{"timezone":"Pacific/Kiritimati"}', 'context only includes rendered league metadata');
  PERFORM pg_temp.check_rules((result->'context'->>'today')::date = (now() AT TIME ZONE 'Pacific/Kiritimati')::date, 'date follows league timezone');
  changed := public.view_league_schedule(f.league_id, f.member_ids[1], '{"weekNumber":18,"date":"2000-01-01","seasonYear":2000}');
  PERFORM pg_temp.check_rules(changed = result, 'client date and week cannot override the league clock');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_league_schedule(%L,%L)', f.league_id, f.member_ids[2]), 'This screen is not available.', 'another member identity is rejected');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record; other record; before_version bigint; result jsonb; source text; plan jsonb; scans jsonb;
BEGIN
  SELECT * INTO f FROM schedule_fixture;
  SELECT (public.view_league_schedule(f.league_id, f.member_ids[1])->'context'->>'version')::bigint INTO before_version;
  UPDATE private.screen_refresh_queue SET dirty = false WHERE league_season_id = f.season_id;
  UPDATE public.matchups SET home_points = 123 WHERE league_season_id = f.season_id AND week_number = 5;
  PERFORM private.refresh_queue_screen_views(f.league_id);
  result := public.view_league_schedule(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules((result->'context'->>'version')::bigint > before_version, 'matchup changes advance the screen publication version');
  PERFORM pg_temp.check_rules((result->'schedule'->4->>'myPoints')::numeric = 123, 'score changes are read directly without stale totals');
  UPDATE public.matchups SET is_voided = true WHERE league_season_id = f.season_id AND week_number = 6;
  result := public.view_league_schedule(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(result->'schedule'->5->'opponentTeamName' = 'null', 'voided matchups do not show an opponent');
  SELECT * INTO other FROM pg_temp.rules_fixture(4, 9584);
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    SELECT 9584, week, current_date + 60 + week * 7, current_date + 66 + week * 7 FROM generate_series(1,20) week;
  UPDATE public.leagues SET playoff_start_week = 17 WHERE id = other.league_id;
  PERFORM set_config('request.jwt.claim.sub', other.user_ids[1]::text, true);
  result := public.view_league_schedule(other.league_id, other.member_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'schedule') = 18, 'legacy default playoff duration follows team count');
  UPDATE public.leagues SET playoff_entrants = 2, playoff_round_lengths = ARRAY[4] WHERE id = other.league_id;
  result := public.view_league_schedule(other.league_id, other.member_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'schedule') = 20, 'custom playoff duration follows league round lengths');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  INSERT INTO public.matchups(league_id, league_season_id, week_number, end_week_number, home_member_id, away_member_id, matchup_type)
    VALUES(f.league_id, f.season_id, 17, 18, f.member_ids[1], f.member_ids[2], 'playoff_final');
  result := public.view_league_schedule(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(result->'schedule'->16->>'opponentTeamName' = 'Cedar Owls' AND result->'schedule'->17->>'opponentTeamName' = 'Cedar Owls', 'decided multiweek playoff opponents appear for both weeks');
  PERFORM pg_temp.check_rules((SELECT provolatile = 's' FROM pg_proc WHERE oid = 'public.view_league_schedule(uuid,uuid,jsonb)'::regprocedure), 'schedule function is STABLE');
  SELECT prosrc INTO source FROM pg_proc WHERE oid = 'public.view_league_schedule(uuid,uuid,jsonb)'::regprocedure;
  source := replace(replace(replace(source, 'p_league_id', quote_literal(f.league_id) || '::uuid'), 'p_member_id', quote_literal(f.member_ids[1]) || '::uuid'), 'p_params', quote_literal('{}') || '::jsonb');
  PERFORM set_config('enable_seqscan', 'off', true);
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || source INTO plan;
  scans := jsonb_path_query_array(plan, 'strict $.** ? (exists(@."Relation Name") && @."Relation Name" == "matchups")');
  PERFORM pg_temp.check_rules(jsonb_array_length(scans) = 1 AND (scans->0->>'Actual Loops')::integer = 1 AND scans->0->>'Node Type' IN ('Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'), 'one indexed matchup scan per league season');
  RAISE NOTICE 'Matchup scan: %', scans;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
