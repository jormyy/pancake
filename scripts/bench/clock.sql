CREATE SCHEMA IF NOT EXISTS bench;
CREATE TABLE IF NOT EXISTS bench.clock(at timestamptz NOT NULL);
TRUNCATE bench.clock;
INSERT INTO bench.clock VALUES ('2025-10-21T04:00:00Z');
DO $$
BEGIN
  IF to_regprocedure('pg_catalog.bench_real_now()') IS NULL THEN
    ALTER FUNCTION pg_catalog.now() RENAME TO bench_real_now;
    EXECUTE 'CREATE OR REPLACE FUNCTION pg_catalog.bench_real_now() RETURNS timestamptz LANGUAGE internal STABLE PARALLEL SAFE AS ''now''';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz
LANGUAGE sql STABLE AS 'SELECT at FROM bench.clock';
CREATE TABLE IF NOT EXISTS bench.requests(id bigserial PRIMARY KEY, body jsonb NOT NULL);
CREATE OR REPLACE FUNCTION net.http_post(
  url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO bench.requests(body) VALUES(body) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
ALTER DATABASE postgres SET app.supabase_url = 'http://127.0.0.1:56321';
ALTER DATABASE postgres SET app.edge_internal_token = 'tipoff-benchmark-local';
SELECT cron.unschedule(jobid) FROM cron.job;
