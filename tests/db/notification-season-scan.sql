\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE notification_season_calls(season_id uuid);
ALTER FUNCTION private.notif_first_scoring_day(uuid) RENAME TO l4_saved_first_scoring_day;
CREATE FUNCTION private.notif_first_scoring_day(p_league_season_id uuid)
RETURNS date LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO pg_temp.notification_season_calls VALUES(p_league_season_id);
  RETURN private.l4_saved_first_scoring_day(p_league_season_id);
END;
$$;
DO $$
DECLARE f record; v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(10,9496);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  VALUES(9496,1,v_today-7,v_today-1),(9496,2,v_today,v_today+6);
  UPDATE public.league_seasons SET skipped_weeks=ARRAY[1] WHERE id=f.season_id;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES('0029496001',9496,1,v_today-7,'L4A','L4B','Final',now()-interval '7 days'),
    ('0029496002',9496,2,v_today,'L4A','L4B','Scheduled',now()+interval '8 hours');
  PERFORM public.notif_scan_due_atomic();
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM notification_season_calls WHERE season_id=f.season_id),
    'first scoring day is computed once for a ten-member season');
  PERFORM pg_temp.check_rules((SELECT count(*)=10 FROM public.notification_outbox
    WHERE event_type='season_started' AND data->>'leagueSeasonId'=f.season_id::text),
    'every member receives the first scoring day after skipped weeks');
  PERFORM public.notif_scan_due_atomic();
  PERFORM pg_temp.check_rules((SELECT count(*)=10 FROM public.notification_outbox
    WHERE event_type='season_started' AND data->>'leagueSeasonId'=f.season_id::text),
    'a repeated scan preserves recipient deduplication');
  DELETE FROM public.notification_outbox WHERE data->>'leagueSeasonId'=f.season_id::text;
  PERFORM public.notif_scan_due_atomic(now()+interval '1 day');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.notification_outbox
    WHERE event_type='season_started' AND data->>'leagueSeasonId'=f.season_id::text),
    'a later day does not send season-start notifications');
  TRUNCATE notification_season_calls;
  PERFORM public.notif_scan_due_atomic(now()+interval '8 days');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_season_calls WHERE season_id=f.season_id),
    'seasons outside their first playable week skip the game lookup');
  UPDATE public.leagues SET status='offseason' WHERE id=f.league_id;
  TRUNCATE notification_season_calls;
  PERFORM public.notif_scan_due_atomic();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_season_calls WHERE season_id=f.season_id),
    'inactive seasons do not compute a first scoring day');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
