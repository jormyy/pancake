\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE notification_lineup_calls(at timestamptz);
ALTER FUNCTION private.notif_scan_lineups(timestamptz) RENAME TO l4_saved_scan_lineups;
CREATE FUNCTION private.notif_scan_lineups(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO pg_temp.notification_lineup_calls VALUES(p_now);
END;
$$;
DO $$
DECLARE v_now timestamptz:='2100-10-27T16:00:00Z';
BEGIN
  PERFORM public.notif_scan_due_atomic(v_now);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_lineup_calls),'no games skips lineup scanning');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES('0029495001',9495,1,'2100-10-27','L4A','L4B','Scheduled',v_now+interval '3 hours');
  PERFORM public.notif_scan_due_atomic(v_now);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_lineup_calls),'games more than two hours away skip lineup scanning');
  UPDATE public.nba_games SET game_time=v_now+interval '2 hours' WHERE nba_game_id='0029495001';
  PERFORM public.notif_scan_due_atomic(v_now);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM notification_lineup_calls),'the two-hour boundary scans lineups');
  TRUNCATE notification_lineup_calls;
  UPDATE public.nba_games SET game_time=v_now-interval '3 hours',status='InProgress',started_at=v_now-interval '3 hours' WHERE nba_game_id='0029495001';
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES('0029495002',9495,1,'2100-10-27','L4C','L4D','Scheduled',v_now+interval '3 hours');
  PERFORM public.notif_scan_due_atomic(v_now);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM notification_lineup_calls),'an earlier game keeps later scheduled games eligible');
  TRUNCATE notification_lineup_calls;
  UPDATE public.nba_games SET game_status_text='Postponed' WHERE nba_game_id='0029495002';
  PERFORM public.notif_scan_due_atomic(v_now);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_lineup_calls),'postponed future games do not trigger a scan');
  UPDATE public.nba_games SET game_status_text=NULL,started_at=v_now-interval '1 minute' WHERE nba_game_id='0029495002';
  PERFORM public.notif_scan_due_atomic(v_now);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_lineup_calls),'a scheduled game with a past start marker does not trigger a scan');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
