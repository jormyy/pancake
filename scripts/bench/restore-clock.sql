DO $$
BEGIN
  IF to_regprocedure('pg_catalog.bench_real_now()') IS NOT NULL THEN
    DROP FUNCTION pg_catalog.now();
    ALTER FUNCTION pg_catalog.bench_real_now() RENAME TO now;
  END IF;
END;
$$;
