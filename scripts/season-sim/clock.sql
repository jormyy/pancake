\set ON_ERROR_STOP on
SELECT :'HOST' IN ('localhost', '127.0.0.1') AND :'PORT' = :'season_sim_port'
  AND current_database() = 'postgres' AS season_sim_safe \gset
\if :season_sim_safe
\else
  \echo 'Refusing a database outside the simulator lane.'
  \quit 3
\endif

BEGIN;
CREATE SCHEMA IF NOT EXISTS season_sim;
REVOKE ALL ON SCHEMA season_sim FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS season_sim.clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sim_ms double precision NOT NULL,
  real_ms double precision NOT NULL,
  rate double precision NOT NULL CHECK (rate >= 0 AND rate <= 100)
);
ALTER TABLE season_sim.clock ADD COLUMN IF NOT EXISTS cap_ms double precision CHECK (cap_ms >= sim_ms);
CREATE TABLE IF NOT EXISTS season_sim.restore_clock (
  name text PRIMARY KEY,
  definition text NOT NULL
);
INSERT INTO season_sim.restore_clock
SELECT proname, pg_get_functiondef(oid)
FROM pg_proc WHERE oid IN ('pg_catalog.now()'::regprocedure,
  'pg_catalog.clock_timestamp()'::regprocedure,
  'pg_catalog.transaction_timestamp()'::regprocedure,
  'pg_catalog.statement_timestamp()'::regprocedure)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION season_sim.real_clock() RETURNS timestamptz
LANGUAGE internal VOLATILE PARALLEL SAFE AS 'clock_timestamp';
CREATE OR REPLACE FUNCTION season_sim.real_transaction() RETURNS timestamptz
LANGUAGE internal STABLE PARALLEL SAFE AS 'now';
CREATE OR REPLACE FUNCTION season_sim.real_statement() RETURNS timestamptz
LANGUAGE internal STABLE PARALLEL SAFE AS 'statement_timestamp';

INSERT INTO season_sim.clock(singleton,sim_ms,real_ms,rate,cap_ms)
VALUES (true, :'sim_ms'::double precision, :'real_ms'::double precision, :'rate'::double precision, :'cap_ms'::double precision)
ON CONFLICT(singleton) DO UPDATE SET sim_ms=EXCLUDED.sim_ms,real_ms=EXCLUDED.real_ms,rate=EXCLUDED.rate,cap_ms=EXCLUDED.cap_ms;

CREATE OR REPLACE FUNCTION season_sim.time(p_real timestamptz DEFAULT season_sim.real_clock()) RETURNS timestamptz
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_timestamp(least(sim_ms + (extract(epoch FROM p_real) * 1000 - real_ms) * rate, cap_ms) / 1000)
  FROM season_sim.clock WHERE singleton
$$;
CREATE TABLE IF NOT EXISTS season_sim.restore_objects (
  kind text NOT NULL, name text NOT NULL, definition text NOT NULL, PRIMARY KEY(kind,name)
);
DO $$
DECLARE saved record; function_name text;
BEGIN
  IF to_regprocedure('pg_catalog.season_sim_native_now()') IS NULL THEN
    PERFORM set_config('season_sim.needs_rebind','on',true);
    DELETE FROM season_sim.restore_objects;
    INSERT INTO season_sim.restore_objects
      SELECT 'function',p.oid::regprocedure::text,pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.prokind='f' AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('sql','plpgsql'))
      ON CONFLICT(kind,name) DO UPDATE SET definition=EXCLUDED.definition;
    INSERT INTO season_sim.restore_objects
      SELECT 'default',format('%I.%I.%I',n.nspname,c.relname,a.attname),
        format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s',n.nspname,c.relname,a.attname,pg_get_expr(d.adbin,d.adrelid))
      FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE (n.nspname IN ('public','private') OR (n.nspname='net' AND c.relname='_http_response')) AND a.attgenerated=''
      ON CONFLICT(kind,name) DO UPDATE SET definition=EXCLUDED.definition;
    FOR saved IN SELECT definition FROM season_sim.restore_clock LOOP EXECUTE saved.definition; END LOOP;
    FOREACH function_name IN ARRAY ARRAY['now','clock_timestamp','transaction_timestamp','statement_timestamp'] LOOP
      EXECUTE format('ALTER FUNCTION pg_catalog.%I() RENAME TO %I',function_name,'season_sim_native_' || function_name);
    END LOOP;
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS 'SELECT season_sim.time(season_sim.real_transaction())';
CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS 'SELECT season_sim.time()';
CREATE OR REPLACE FUNCTION pg_catalog.transaction_timestamp() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS 'SELECT season_sim.time(season_sim.real_transaction())';
CREATE OR REPLACE FUNCTION pg_catalog.statement_timestamp() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS 'SELECT season_sim.time(season_sim.real_statement())';
DO $$
DECLARE saved record;
BEGIN
  IF current_setting('season_sim.needs_rebind',true)='on' THEN
    FOR saved IN SELECT definition FROM season_sim.restore_objects ORDER BY kind,name LOOP EXECUTE saved.definition; END LOOP;
  END IF;
END;
$$;

DO $$
DECLARE saved record;
BEGIN
  FOR saved IN
    SELECT n.nspname AS schema_name,c.relname AS table_name,a.attname AS column_name
    FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    WHERE n.nspname IN ('public','private') AND a.attgenerated=''
      AND pg_get_expr(d.adbin,d.adrelid)='CURRENT_DATE'
  LOOP
    INSERT INTO season_sim.restore_objects(kind,name,definition)
    VALUES ('date-default',format('%I.%I.%I',saved.schema_name,saved.table_name,saved.column_name),
      format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT CURRENT_DATE',saved.schema_name,saved.table_name,saved.column_name))
    ON CONFLICT DO NOTHING;
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT pg_catalog.now()::date',
      saved.schema_name,saved.table_name,saved.column_name);
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND pg_get_expr(d.adbin,d.adrelid) ~* 'CURRENT_(TIMESTAMP|TIME|DATE)|LOCAL(TIMESTAMP|TIME)'
  ) THEN RAISE EXCEPTION 'Public defaults contain clock keywords that cannot use the simulator clock.';
  END IF;
END;
$$;
DO $$
DECLARE policy record; command text;
BEGIN
  FOR policy IN SELECT * FROM pg_policies WHERE schemaname IN ('public','private')
    AND (coalesce(qual,'') || coalesce(with_check,'')) LIKE '%season_sim_native_%' LOOP
    command := format('ALTER POLICY %I ON %I.%I',policy.policyname,policy.schemaname,policy.tablename)
      || CASE WHEN policy.qual IS NULL THEN '' ELSE ' USING (' || replace(policy.qual,'season_sim_native_','') || ')' END
      || CASE WHEN policy.with_check IS NULL THEN '' ELSE ' WITH CHECK (' || replace(policy.with_check,'season_sim_native_','') || ')' END;
    INSERT INTO season_sim.restore_objects VALUES('policy',policy.schemaname || '.' || policy.tablename || '.' || policy.policyname,command) ON CONFLICT DO NOTHING;
    EXECUTE command;
  END LOOP;
END;
$$;
SELECT cron.unschedule(jobid) FROM cron.job;
COMMIT;
