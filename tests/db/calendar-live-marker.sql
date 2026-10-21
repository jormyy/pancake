\getenv post_calendar_db SUPABASE_DB_URL
\getenv post_calendar_port PANCAKE_TEST_DB_PORT
\if :{?post_calendar_db}
\else
  \echo SUPABASE_DB_URL is required
  \quit 3
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
DECLARE game uuid:=gen_random_uuid(); provider_id text:='002-marker-'||gen_random_uuid(); year int;
BEGIN
  SELECT candidate INTO year FROM generate_series(9400,9499) candidate WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=candidate) LIMIT 1;
  IF year IS NULL THEN RAISE EXCEPTION 'No empty synthetic probe year'; END IF;
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_status_text)
  VALUES(game,provider_id,year,1,current_date,'BOS','MIA','Scheduled','Postponed');
  PERFORM save_live_scoreboard_atomic(game,provider_id,'Scheduled',0,0,'',0);
  IF (SELECT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE id=game) THEN
    RAISE EXCEPTION 'FAIL: a stale Scheduled live scoreboard clears confirmed unavailability';
  END IF;
END; $$;
ROLLBACK;
