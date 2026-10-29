\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$ BEGIN
  IF to_regclass('season_sim.clock') IS NULL OR current_setting('app.supabase_url', true) IS DISTINCT FROM 'http://host.lima.internal:57281' THEN
    RAISE EXCEPTION 'The clock probe requires the private lab runtime';
  END IF;
END $$;
SET LOCAL application_name = 'perf-lab-clock-probe';
SET LOCAL pg_stat_statements.track = 'none';
CREATE FUNCTION pg_temp.capture_clock() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS 'SELECT season_sim.time(season_sim.real_transaction())';
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
\echo BEFORE
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
\echo BEFORE_REPEAT
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
SELECT 'clock_before', min(pg_temp.capture_clock()), max(pg_temp.capture_clock()) FROM generate_series(1, 200);
ALTER FUNCTION pg_temp.capture_clock() SET auto_explain.log_min_duration = '-1';
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
\echo AFTER
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
\echo AFTER_REPEAT
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
SELECT 'clock_after', min(pg_temp.capture_clock()), max(pg_temp.capture_clock()) FROM generate_series(1, 200);
ALTER FUNCTION pg_temp.capture_clock() RESET auto_explain.log_min_duration;
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
\echo RESTORED
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT count(pg_temp.capture_clock()) FROM generate_series(1, 200);
SELECT 'global_plan_logging', current_setting('auto_explain.log_min_duration');
ROLLBACK;
