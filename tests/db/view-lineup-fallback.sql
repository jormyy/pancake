BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; result jsonb; selected date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9565);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  result := public.view_lineup(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules((result->'context'->>'weekNumber')::integer = 1, 'lineup uses the existing week one fallback without a seeded calendar');
  PERFORM pg_temp.check_rules(result->'weekDays' = '[]', 'empty calendar and slate have no day rows');
  PERFORM pg_temp.check_rules(public.view_home(f.league_id, f.member_ids[1])->'matchup' = 'null', 'home preserves the empty matchup without a seeded calendar');
  INSERT INTO public.nba_games(nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES('002screen-lineup-fallback', 9565, 1, selected, 'VST', 'OTH', 'Scheduled');
  result := public.view_lineup(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'weekDays') = 1, 'unseeded lineup dates use the existing game week fallback');
  PERFORM pg_temp.check_rules((result->'weekDays'->0->>'date')::date = selected, 'fallback date matches the existing game date read');
  PERFORM pg_temp.check_rules((result->'weekDays'->0->>'hasGames')::boolean, 'fallback day reports the existing scheduled game');
  PERFORM pg_temp.check_rules(result->'weekDays'->0->'playingTeams' @> '["VST","OTH"]', 'fallback includes both playing teams');
  result := public.view_lineup(f.league_id, f.member_ids[1], '{"weekNumber":2}');
  PERFORM pg_temp.check_rules(result->'weekDays' = '[]', 'fallback does not mix different game weeks');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
