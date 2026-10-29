\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='statistics-fixture';
\ir rules-support.sql
DO $$
DECLARE result jsonb; work_id bigint; token uuid:=gen_random_uuid(); source text; job_id bigint;
BEGIN
  PERFORM pg_temp.check_rules(cardinality(private.screen_statistics_targets())=15,'all screen statistics targets remain registered');
  PERFORM pg_temp.check_rules(NOT EXISTS(
    SELECT FROM unnest(private.screen_statistics_targets()) relation
    JOIN pg_class parent ON parent.oid=relation
    CROSS JOIN LATERAL (
      SELECT parent.oid WHERE parent.relkind='r'
      UNION SELECT relid FROM pg_partition_tree(relation) WHERE isleaf
    ) physical JOIN pg_class leaf ON leaf.oid=physical.oid
    WHERE NOT coalesce(leaf.reloptions @> ARRAY['autovacuum_analyze_scale_factor=0.02','autovacuum_analyze_threshold=25'],false)
  ),'physical screen tables retain the autovacuum analyze policy');
  PERFORM pg_temp.check_rules((SELECT retired_at IS NOT NULL FROM private.work_kinds WHERE kind='analyze-screen-table'),'the old work kind is retired');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM private.work_items WHERE kind='analyze-screen-table' AND status IN ('pending','running','failed')),'migration closes every stale analysis item');
  PERFORM pg_temp.check_rules(private.work_enqueue('analyze-screen-table','retired-statistics-'||gen_random_uuid()) IS NULL,'retired work cannot be enqueued');
  INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,payload)
    VALUES('analyze-screen-table','retired-lease-'||gen_random_uuid(),'running',token,now()+interval '1 minute','{"relation":"public.players"}') RETURNING id INTO work_id;
  PERFORM private.work_execute(work_id,token);
  PERFORM pg_temp.check_rules((SELECT status='dead' AND lease_token IS NULL FROM private.work_items WHERE id=work_id),'a stale lease cannot execute retired maintenance');
  INSERT INTO private.work_items(kind,key,status,payload)
    VALUES('analyze-screen-table','retired-pending-'||gen_random_uuid(),'pending','{"relation":"public.players"}') RETURNING id INTO work_id;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM private.work_claim(4) WHERE id=work_id),'claims exclude retired work');
  SELECT command INTO source FROM cron.job WHERE jobname='screen-statistics';
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND min(schedule)='15 10 * * *' FROM cron.job WHERE jobname='screen-statistics'),'one independent daily job runs at 10:15 UTC');
  PERFORM pg_temp.check_rules(source LIKE '%statement_timeout=''10min''%' AND source LIKE '%lock_timeout=''2s''%' AND source LIKE '%private.refresh_screen_statistics()%','the cron command owns its timeout budgets');
  SELECT jobid INTO job_id FROM cron.job WHERE jobname='screen-statistics';
  PERFORM cron.schedule('screen-statistics','15 10 * * *',source);
  PERFORM pg_temp.check_rules((SELECT jobid=job_id FROM cron.job WHERE jobname='screen-statistics'),'scheduling the named job again preserves its identity');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.refresh_screen_statistics()','EXECUTE')
    AND NOT has_function_privilege('anon','private.refresh_screen_statistics()','EXECUTE')
    AND NOT has_function_privilege('service_role','private.refresh_screen_statistics()','EXECUTE'),'clients cannot run statistics maintenance');
  PERFORM pg_temp.check_rules(to_regprocedure('private.analyze_screen_table(text)') IS NULL,'the inline analysis helper is removed');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM pg_trigger WHERE tgname IN ('trade_rankings_analyze_insert','trade_rankings_analyze_update','trade_rankings_analyze_delete')),'trade writes cannot run analysis through triggers');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','private','analytics') AND p.prokind='f'
      AND p.oid<>'private.refresh_screen_statistics()'::regprocedure
      AND p.prosrc ~* $maintenance$(^|[[:space:];'"])(ANALYZE|VACUUM|REINDEX)([[:space:](;]|$)$maintenance$),'only the independent job contains database maintenance');
  result:=private.refresh_screen_statistics();
  PERFORM pg_temp.check_rules(jsonb_array_length(result)=15,'the separate job visits each target once');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM jsonb_array_elements(result) row WHERE row->>'status'<>'analyzed'),'every unlocked target is analyzed');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
