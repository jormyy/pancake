\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='statistics-fixture';
\ir rules-support.sql
INSERT INTO public.players(first_name,last_name) VALUES('Statistics','First'),('Statistics','Second'),('Statistics','Third');
UPDATE private.work_items SET status='succeeded',lease_until=NULL,lease_token=NULL
WHERE status IN ('pending','running','failed');
DO $$
DECLARE item private.work_items%ROWTYPE; work_id bigint; target regclass; child regclass; previous_count integer;
  original_hash text; current_hash text; guard_failed boolean:=false;
BEGIN
  PERFORM pg_temp.check_rules(cardinality(private.screen_statistics_targets())=15,'all screen statistics targets are registered');
  PERFORM pg_temp.check_rules(NOT EXISTS(
    SELECT FROM unnest(private.screen_statistics_targets()) relation
    JOIN pg_class parent ON parent.oid=relation
    CROSS JOIN LATERAL (
      SELECT parent.oid WHERE parent.relkind='r'
      UNION SELECT relid FROM pg_partition_tree(relation) WHERE isleaf
    ) physical JOIN pg_class leaf ON leaf.oid=physical.oid
    WHERE NOT coalesce(leaf.reloptions @> ARRAY['autovacuum_analyze_scale_factor=0.02','autovacuum_analyze_threshold=25'],false)
  ),'every physical screen table has the analyze policy');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.analyze_screen_table(text)','EXECUTE')
    AND NOT has_function_privilege('anon','private.analyze_screen_table(text)','EXECUTE')
    AND NOT has_function_privilege('service_role','private.analyze_screen_table(text)','EXECUTE'),'clients cannot request arbitrary analysis');
  BEGIN
    PERFORM private.analyze_screen_table('auth.users');
  EXCEPTION WHEN invalid_parameter_value THEN guard_failed:=true;
  END;
  PERFORM pg_temp.check_rules(guard_failed,'the analyzer rejects a table outside the allowlist');
  guard_failed:=false;
  BEGIN
    PERFORM private.analyze_screen_table(NULL);
  EXCEPTION WHEN invalid_parameter_value THEN guard_failed:=true;
  END;
  PERFORM pg_temp.check_rules(guard_failed,'the analyzer rejects a missing table');
  SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) INTO original_hash FROM public.players p;
  PERFORM private.analyze_screen_table('public.players');
  SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) INTO current_hash FROM public.players p;
  PERFORM pg_temp.check_rules(original_hash IS NOT DISTINCT FROM current_hash,'analysis preserves every player value');
  work_id:=private.work_enqueue('retention-prune','statistics-fixture-'||gen_random_uuid(),now());
  SELECT * INTO item FROM private.work_claim(1) WHERE id=work_id;
  PERFORM pg_temp.check_rules(item.lease_token IS NOT NULL,'the retention task receives a lease');
  PERFORM private.work_execute(item.id,item.lease_token);
  SELECT count(*) INTO previous_count FROM private.work_items
    WHERE kind='analyze-screen-table' AND key LIKE (now() AT TIME ZONE 'UTC')::date::text||':%';
  PERFORM pg_temp.check_rules(previous_count=15,'retention schedules one daily analysis task per target');
  FOREACH target IN ARRAY private.screen_statistics_targets() LOOP
    PERFORM pg_temp.check_rules(EXISTS(SELECT FROM private.work_items WHERE kind='analyze-screen-table'
      AND to_regclass(payload->>'relation')=target),'the task preserves its exact target: '||target::text);
  END LOOP;
  UPDATE private.work_items SET status='succeeded',lease_until=NULL,lease_token=NULL WHERE kind='analyze-screen-table';
  work_id:=private.work_enqueue('retention-prune','statistics-fixture-repeat-'||gen_random_uuid(),now());
  SELECT * INTO item FROM private.work_claim(1) WHERE id=work_id;
  PERFORM private.work_execute(item.id,item.lease_token);
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.work_items WHERE kind='analyze-screen-table'
    AND key LIKE (now() AT TIME ZONE 'UTC')::date::text||':%')=previous_count,'repeated retention does not duplicate daily analysis');
  work_id:=private.work_enqueue('analyze-screen-table','statistics-fixture-execute-'||gen_random_uuid(),now(),jsonb_build_object('relation','public.players'));
  SELECT * INTO item FROM private.work_claim(1) WHERE id=work_id;
  PERFORM private.work_execute(item.id,item.lease_token);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM private.work_items WHERE id=item.id),'the analyzer completes through the real work dispatcher');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES('002statistics-fixture',2202,1,'2201-10-01','BOS','LAL','Scheduled');
  child:=private.ensure_player_stats_partition(2202);
  PERFORM pg_temp.check_rules((SELECT reloptions @> ARRAY['autovacuum_analyze_scale_factor=0.02','autovacuum_analyze_threshold=25']
    FROM pg_class WHERE oid=child),'future stats partitions receive the same analyze policy');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
