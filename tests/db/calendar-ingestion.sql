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
SET LOCAL statement_timeout='60s';
CREATE FUNCTION pg_temp.must(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
DO $$
DECLARE
  year int:=9470; day date:='9469-10-22'; game jsonb; weeks jsonb; label text:=current_setting('post.calendar_case');
  before_state jsonb; after_state jsonb; result_count int; game_key text:='002-calendar-'||gen_random_uuid();
BEGIN
  IF EXISTS(SELECT 1 FROM season_weeks WHERE season_year=year) OR EXISTS(SELECT 1 FROM nba_games WHERE season_year=year) THEN
    RAISE EXCEPTION 'The synthetic calendar year is occupied';
  END IF;
  game:=jsonb_build_object('nba_game_id',game_key,'season_year',year,'game_date',day,'week_number',1,
    'home_team','BOS','away_team','MIA','status','Scheduled','game_status_text','Postponed','game_time',day::text||'T23:00:00Z');
  weeks:=jsonb_build_array(jsonb_build_object('season_year',year,'week_number',1,'week_start',day,'week_end',day+5),
    jsonb_build_object('season_year',year,'week_number',2,'week_start',day+6,'week_end',day+12),
    jsonb_build_object('season_year',year,'week_number',3,'week_start',day+13,'week_end',day+19));
  PERFORM publish_nba_schedule_atomic(year,jsonb_build_array(game),weeks);
  IF label='durable' THEN
    PERFORM publish_nba_schedule_atomic(year,jsonb_build_array(game||jsonb_build_object('game_status_text','','game_time',day::text||'T22:00:00Z')),'[]');
    PERFORM pg_temp.must((SELECT NOT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id=game_key),
      'blank text and a stale tipoff cannot clear a confirmed postponement');
    PERFORM publish_nba_schedule_atomic(year,jsonb_build_array((game-'game_status_text')||jsonb_build_object('game_time',day::text||'T21:00:00Z')),'[]');
    PERFORM pg_temp.must((SELECT NOT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id=game_key),
      'omitted text and clock changes preserve the marker');
    PERFORM publish_nba_schedule_atomic(year,jsonb_build_array((game-'game_status_text')||jsonb_build_object('status','Final')),'[]');
    PERFORM pg_temp.must((SELECT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id=game_key),'actual played Final clears the marker');
  ELSIF label='outside' THEN
    PERFORM publish_nba_schedule_atomic(year,jsonb_build_array((game-'game_status_text')||jsonb_build_object('game_date',day+21,'week_number',4,'game_time',(day+21)::text||'T23:00:00Z')),'[]');
    PERFORM pg_temp.must((SELECT game_date=day+21 AND private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id=game_key),
      'a genuine makeup outside recorded bounds publishes without aborting');
    PERFORM pg_temp.must((SELECT count(*)=1 FROM season_weeks week JOIN nba_games game ON game.season_year=week.season_year AND game.week_number=week.week_number
      AND game.game_date BETWEEN week.week_start AND week.week_end WHERE game.nba_game_id=game_key),'the makeup belongs to exactly one stored fantasy week');
  ELSIF label='cross-week' THEN
    PERFORM publish_nba_schedule_atomic(year,jsonb_build_array((game-'game_status_text')||jsonb_build_object('game_date',day+14,'week_number',3,'game_time',(day+14)::text||'T23:00:00Z')),'[]');
    PERFORM pg_temp.must((SELECT week_number=3 AND game_date=day+14 AND private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id=game_key),'a genuine cross-week makeup clears the marker');
  END IF;
END;
$$;
ROLLBACK;
