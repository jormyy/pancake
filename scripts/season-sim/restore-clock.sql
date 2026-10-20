\set ON_ERROR_STOP on
SELECT :'HOST' IN ('localhost', '127.0.0.1') AND :'PORT' = '56222'
  AND current_database() = 'postgres' AS season_sim_safe \gset
\if :season_sim_safe
\else
  \echo 'Refusing a database outside the simulator lane.'
  \quit 3
\endif

BEGIN;
CREATE TEMP TABLE current_clock_bindings(definition text) ON COMMIT DROP;
INSERT INTO current_clock_bindings
SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','private') AND p.prokind='f' AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('sql','plpgsql'));
INSERT INTO current_clock_bindings
SELECT format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s',n.nspname,c.relname,a.attname,pg_get_expr(d.adbin,d.adrelid))
FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
WHERE n.nspname IN ('public','private') AND a.attgenerated='';
INSERT INTO current_clock_bindings
SELECT format('ALTER POLICY %I ON %I.%I',policyname,schemaname,tablename)
  || CASE WHEN qual IS NULL THEN '' ELSE ' USING (' || qual || ')' END
  || CASE WHEN with_check IS NULL THEN '' ELSE ' WITH CHECK (' || with_check || ')' END
FROM pg_policies WHERE schemaname IN ('public','private');
DO $$
DECLARE name text; saved record;
BEGIN
  IF to_regprocedure('pg_catalog.season_sim_native_now()') IS NOT NULL THEN
    FOREACH name IN ARRAY ARRAY['now','clock_timestamp','transaction_timestamp','statement_timestamp'] LOOP
      EXECUTE format('ALTER FUNCTION pg_catalog.%I() RENAME TO %I',name,'season_sim_virtual_' || name);
      EXECUTE format('ALTER FUNCTION pg_catalog.%I() RENAME TO %I','season_sim_native_' || name,name);
    END LOOP;
    FOR saved IN SELECT definition FROM current_clock_bindings LOOP EXECUTE saved.definition; END LOOP;
    FOREACH name IN ARRAY ARRAY['now','clock_timestamp','transaction_timestamp','statement_timestamp'] LOOP
      EXECUTE format('DROP FUNCTION pg_catalog.%I()','season_sim_virtual_' || name);
    END LOOP;
  END IF;
END;
$$;
COMMIT;
