BEGIN;
\ir rules-support.sql
DO $$
DECLARE before_count bigint; result jsonb;
BEGIN
  result:=public.set_worker_paused(true,'fixture');
  SELECT count(*) INTO before_count FROM private.work_items;
  PERFORM pg_temp.check_rules(result->>'paused'='true','operator pauses scheduling');
  PERFORM pg_temp.check_rules(public.dispatch_work()=0,'paused dispatcher claims nothing');
  PERFORM pg_temp.check_rules((SELECT count(*)=before_count FROM private.work_items),'pause stops scheduled enqueue before work claims');
  result:=public.set_worker_paused(false,'resume');
  PERFORM pg_temp.check_rules(result->>'paused'='false','operator resumes scheduling');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.set_worker_paused(boolean,text)','EXECUTE'),'members cannot pause workers');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.set_worker_paused(boolean,text)','EXECUTE'),'anonymous users cannot pause workers');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
