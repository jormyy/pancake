BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE statistics_gate_source(id integer PRIMARY KEY, value integer) WITH(autovacuum_analyze_threshold=2,autovacuum_analyze_scale_factor=0);
INSERT INTO statistics_gate_source VALUES(1,10),(2,20);
ANALYZE statistics_gate_source;
CREATE OR REPLACE FUNCTION private.screen_statistics_targets()
RETURNS regclass[] LANGUAGE sql STABLE SET search_path='' AS $$ SELECT ARRAY['pg_temp.statistics_gate_source'::regclass] $$;
DO $$
DECLARE result jsonb;
BEGIN
  result:=private.refresh_screen_statistics();
  PERFORM pg_temp.check_rules(result->0->>'status'='fresh','fresh statistics skip ANALYZE at the modification threshold');
  UPDATE statistics_gate_source SET value=11 WHERE id=1;
  result:=private.refresh_screen_statistics();
  PERFORM pg_temp.check_rules(result->0->>'status'='analyzed','pending transaction changes above the table threshold trigger ANALYZE');
  PERFORM pg_temp.check_rules((SELECT array_agg(value ORDER BY id)=ARRAY[11,20] FROM statistics_gate_source),'statistics refresh preserves table values');
END;
$$;
CREATE TEMP TABLE statistics_gate_never(id integer);
CREATE OR REPLACE FUNCTION private.screen_statistics_targets()
RETURNS regclass[] LANGUAGE sql STABLE SET search_path='' AS $$ SELECT ARRAY['pg_temp.statistics_gate_never'::regclass] $$;
DO $$
BEGIN
  PERFORM pg_temp.check_rules(private.refresh_screen_statistics()->0->>'status'='analyzed','a never-analyzed empty table gets initial statistics');
END;
$$;
ANALYZE statistics_gate_never;
TRUNCATE statistics_gate_never;
DO $$
BEGIN
  PERFORM pg_temp.check_rules((SELECT reltuples=0 FROM pg_class WHERE oid='pg_temp.statistics_gate_never'::regclass),'truncate resets the empty catalog estimate');
  PERFORM pg_temp.check_rules(private.refresh_screen_statistics()->0->>'status'='fresh','a valid empty estimate after truncate skips sampling');
END;
$$;
CREATE TEMP TABLE statistics_gate_parent(id integer, value integer) PARTITION BY RANGE(id);
CREATE TEMP TABLE statistics_gate_leaf PARTITION OF statistics_gate_parent FOR VALUES FROM(0) TO(1000) WITH(autovacuum_analyze_threshold=2,autovacuum_analyze_scale_factor=0);
INSERT INTO statistics_gate_parent VALUES(1,10),(2,20);
ANALYZE statistics_gate_parent;
CREATE OR REPLACE FUNCTION private.screen_statistics_targets()
RETURNS regclass[] LANGUAGE sql STABLE SET search_path='' AS $$ SELECT ARRAY['pg_temp.statistics_gate_parent'::regclass] $$;
DO $$
BEGIN
  PERFORM pg_temp.check_rules(private.refresh_screen_statistics()->0->>'status'='fresh','fresh parent and leaf statistics skip ANALYZE');
  UPDATE statistics_gate_leaf SET value=11 WHERE id=1;
  PERFORM pg_temp.check_rules(private.refresh_screen_statistics()->0->>'status'='analyzed','leaf changes make the partitioned target stale');
  PERFORM pg_temp.check_rules((SELECT array_agg(value ORDER BY id)=ARRAY[11,20] FROM statistics_gate_parent),'partition refresh preserves table values');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM cron.job WHERE jobname='screen-statistics' AND schedule='15 10 * * *'),'statistics keep the separate daily cron');
  PERFORM pg_temp.check_rules(private.work_enqueue('analyze-screen-table','statistics-retired') IS NULL,'retired statistics work cannot be enqueued');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
