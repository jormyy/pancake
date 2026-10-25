\set ON_ERROR_STOP on
\getenv post_calendar_db SUPABASE_DB_URL
\getenv post_calendar_port PANCAKE_TEST_DB_PORT
\if :{?post_calendar_db}
\else
  \echo SUPABASE_DB_URL is required
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
\if :{?post_calendar_port}
\else
  \set post_calendar_port 54322
\endif
SELECT set_config('post.calendar_db', :'post_calendar_db',false) \gset
SELECT set_config('post.calendar_port', :'post_calendar_port',false) \gset
DO $$ BEGIN
  IF current_setting('post.calendar_port') !~ '^[0-9]+$' OR current_setting('post.calendar_db') !~
    format('^postgres(ql)?://[^/@]+@(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$',current_setting('post.calendar_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback database port is allowed';
  END IF;
END $$;
BEGIN;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE
  game uuid:=gen_random_uuid();
  provider_id text:='002-marker-'||gen_random_uuid();
  year int;
  marker text;
  incoming text;
  resumed_status text;
  revision_before bigint;
BEGIN
  SELECT candidate INTO year FROM generate_series(9400,9499) candidate
    WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=candidate)
      AND NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=candidate)
      AND NOT EXISTS(SELECT 1 FROM league_seasons WHERE season_year=candidate) LIMIT 1;
  IF year IS NULL THEN RAISE EXCEPTION 'No empty synthetic probe year'; END IF;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    VALUES(year,12,'2026-01-05','2026-01-11'),(year,15,'2026-01-26','2026-02-01');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,game_status_text)
    VALUES(game,provider_id,year,12,'2026-01-08','2026-01-08T23:00:00Z','CHI','MIA','Scheduled','Postponed');
  FOREACH marker IN ARRAY ARRAY['Postponed','Cancelled','Suspended','PPD - confirmed'] LOOP
    UPDATE nba_games SET status='Scheduled',game_status_text=marker,live_scoreboard_elapsed_seconds=0 WHERE id=game;
    FOREACH incoming IN ARRAY ARRAY[NULL::text,'','7:00 PM ET'] LOOP
      SELECT revision INTO revision_before FROM private.score_input_revisions WHERE scope='nba:'||year||':12';
      IF NOT save_live_scoreboard_atomic(game,provider_id,'Scheduled',0,0,incoming,0) THEN
        RAISE EXCEPTION 'The Scheduled snapshot must reach the marker guard';
      END IF;
      IF (SELECT game_status_text IS DISTINCT FROM marker OR private.lineup_game_available(status,game_status_text) FROM nba_games WHERE id=game) THEN
        RAISE EXCEPTION 'FAIL: a stale Scheduled live scoreboard clears confirmed unavailability';
      END IF;
      IF EXISTS(SELECT 1 FROM get_score_sync_games('2026-01-08','2026-01-08',year) WHERE id=game)
        OR EXISTS(SELECT 1 FROM get_live_poll_work('2026-01-08T23:00:00Z') WHERE id=game) THEN
        RAISE EXCEPTION 'A stale Scheduled snapshot must not re-enable scoring or polling';
      END IF;
      IF (SELECT revision FROM private.score_input_revisions WHERE scope='nba:'||year||':12') IS DISTINCT FROM revision_before THEN
        RAISE EXCEPTION 'A preserved marker must not invalidate score inputs';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH resumed_status IN ARRAY ARRAY['InProgress','Final'] LOOP
    UPDATE nba_games SET status='Scheduled',game_status_text='Postponed',live_scoreboard_elapsed_seconds=0 WHERE id=game;
    IF NOT save_live_scoreboard_atomic(game,provider_id,resumed_status,3,2,'',120) THEN
      RAISE EXCEPTION 'A real live resumption must be accepted';
    END IF;
    IF NOT (SELECT status=resumed_status AND private.lineup_game_available(status,game_status_text) FROM nba_games WHERE id=game)
      OR NOT EXISTS(SELECT 1 FROM get_score_sync_games('2026-01-08','2026-01-08',year) WHERE id=game) THEN
      RAISE EXCEPTION 'InProgress and Final must clear an old unavailable marker';
    END IF;
  END LOOP;
  UPDATE nba_games SET status='Scheduled',game_status_text='Postponed',live_scoreboard_elapsed_seconds=0 WHERE id=game;
  PERFORM save_live_scoreboard_atomic(game,provider_id,'Scheduled',0,0,'7:00 PM ET',0);
  IF EXISTS(SELECT 1 FROM get_live_poll_work('2026-01-29T23:00:00Z') WHERE id=game)
    OR (SELECT game_date<>'2026-01-08' OR private.lineup_game_available(status,game_status_text) FROM nba_games WHERE id=game) THEN
    RAISE EXCEPTION 'Tipoff text alone must not move or re-enable the original postponed game';
  END IF;
  PERFORM publish_nba_schedule_atomic(year,jsonb_build_array(jsonb_build_object(
    'nba_game_id',provider_id,'season_year',year,'week_number',15,'game_date','2026-01-29',
    'game_time','2026-01-29T23:00:00Z','home_team','CHI','away_team','MIA','status','Scheduled','game_status_text','7:00 PM ET'
  )),'[]'::jsonb);
  IF NOT (SELECT id=game AND game_date='2026-01-29' AND week_number=15 AND private.lineup_game_available(status,game_status_text)
      FROM nba_games WHERE nba_game_id=provider_id)
    OR NOT EXISTS(SELECT 1 FROM get_live_poll_work('2026-01-29T23:00:00Z') WHERE id=game AND needs_scoreboard) THEN
    RAISE EXCEPTION 'The publisher must re-enable the same game on its makeup date before live tipoff polling';
  END IF;
  PERFORM save_live_scoreboard_atomic(game,provider_id,'Scheduled',0,0,'7:00 PM ET',0);
  IF NOT (SELECT game_status_text='7:00 PM ET' AND private.lineup_game_available(status,game_status_text) FROM nba_games WHERE id=game) THEN
    RAISE EXCEPTION 'A tipoff snapshot must remain available after the publisher confirms the makeup';
  END IF;
  PERFORM save_live_scoreboard_atomic(game,provider_id,'Scheduled',0,0,'Cancelled',0);
  IF (SELECT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE id=game) THEN
    RAISE EXCEPTION 'A new confirmed cancellation must still be stored';
  END IF;
  RAISE NOTICE 'PASS: stale Scheduled markers, live resumption, publisher makeup, tipoff polling and cancellation';
END;
$$;
ROLLBACK;
