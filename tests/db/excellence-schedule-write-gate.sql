\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
CREATE TEMP TABLE schedule_gate_input AS
SELECT jsonb_agg(jsonb_build_object('nba_game_id',nba_game_id,'season_year',season_year,'game_date',game_date,
  'home_team',home_team,'away_team',away_team,'status',status,'game_status_text',game_status_text,'week_number',week_number,
  'started_at',started_at,'game_time',game_time,'bbref_home_team',bbref_home_team,'bbref_away_team',bbref_away_team,
  'schedule_complete',false) ORDER BY nba_game_id) AS games
FROM public.nba_games WHERE season_year=2027;
CREATE TEMP TABLE schedule_gate_weeks AS
SELECT jsonb_agg(jsonb_build_object('season_year',season_year,'week_number',week_number,'week_start',week_start,'week_end',week_end) ORDER BY week_number) AS weeks
FROM public.season_weeks WHERE season_year=2027;
CREATE TEMP TABLE schedule_gate_before AS
SELECT pg_stat_get_xact_tuples_updated('public.nba_games'::regclass) AS updated,
  md5(string_agg((to_jsonb(game)-'updated_at')::text,'' ORDER BY nba_game_id)) AS fingerprint
FROM public.nba_games game WHERE season_year=2027;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT public.publish_nba_schedule_atomic(2027,games,weeks) FROM schedule_gate_input CROSS JOIN schedule_gate_weeks;
SELECT jsonb_build_object('gameUpdates',pg_stat_get_xact_tuples_updated('public.nba_games'::regclass)-updated) FROM schedule_gate_before;
DO $$
DECLARE fingerprint text;
BEGIN
  SELECT md5(string_agg((to_jsonb(game)-'updated_at')::text,'' ORDER BY nba_game_id)) INTO fingerprint
  FROM public.nba_games game WHERE season_year=2027;
  IF fingerprint IS DISTINCT FROM (SELECT before.fingerprint FROM schedule_gate_before before) THEN
    RAISE EXCEPTION 'An identical schedule changes stored game values';
  END IF;
  IF pg_stat_get_xact_tuples_updated('public.nba_games'::regclass)<>(SELECT updated FROM schedule_gate_before) THEN
    RAISE EXCEPTION 'An identical schedule rewrites game rows';
  END IF;
END;
$$;
ROLLBACK;
