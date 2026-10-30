-- Canonical SQL source for private.ensure_log_partition.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.ensure_log_partition(p_parent regclass,p_start date)
RETURNS regclass LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE policy private.partitioned_log_policies%ROWTYPE; child regclass; child_name text; schema_name text; parent_name text; column_names text;
  range_start date:=date_trunc('month',p_start)::date; range_end date:=(date_trunc('month',p_start)+interval '1 month')::date;
BEGIN
  SELECT parent_table,time_column,identity_column INTO STRICT policy FROM private.partitioned_log_policies WHERE parent_table=p_parent;
  SELECT partition_table INTO child FROM private.log_partitions WHERE parent_table=p_parent AND lower_bound=range_start;
  IF child IS NOT NULL THEN RETURN child; END IF;
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',p_parent);
  SELECT partition_table INTO child FROM private.log_partitions WHERE parent_table=p_parent AND lower_bound=range_start;
  IF child IS NOT NULL THEN RETURN child; END IF;
  SELECT n.nspname,c.relname INTO schema_name,parent_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=p_parent;
  child_name:=parent_name||'_y'||to_char(range_start,'YYYY')||'m'||to_char(range_start,'MM');
  EXECUTE format('CREATE TABLE %I.%I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING STORAGE) WITH (fillfactor=90,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.05,autovacuum_vacuum_threshold=50,autovacuum_analyze_threshold=50)',schema_name,child_name,p_parent);
  EXECUTE format('ALTER TABLE %I.%I ADD CHECK (%I >= %L::timestamptz AND %I < %L::timestamptz)',schema_name,child_name,policy.time_column,range_start||' 00:00:00+00',policy.time_column,range_end||' 00:00:00+00');
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO column_names FROM pg_attribute WHERE attrelid=p_parent AND attnum>0 AND NOT attisdropped;
  EXECUTE format('WITH moved AS (DELETE FROM %I.%I WHERE %I >= $1 AND %I < $2 RETURNING %s) INSERT INTO %I.%I(%s) SELECT %s FROM moved',schema_name,parent_name||'_default',policy.time_column,policy.time_column,column_names,schema_name,child_name,column_names,column_names)
    USING range_start::timestamp AT TIME ZONE 'UTC',range_end::timestamp AT TIME ZONE 'UTC';
  EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I.%I FOR VALUES FROM (%L) TO (%L)',p_parent,schema_name,child_name,range_start||' 00:00:00+00',range_end||' 00:00:00+00');
  child:=format('%I.%I',schema_name,child_name)::regclass;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',child);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,anon,authenticated,service_role',child);
  IF schema_name='public' THEN EXECUTE format('GRANT SELECT ON %s TO service_role',child); END IF;
  INSERT INTO private.log_partitions(parent_table,partition_table,lower_bound,upper_bound) VALUES(p_parent,child,range_start,range_end);
  INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES(child::text,'Monthly partition of '||p_parent::text||'; retention follows its parent')
    ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule WHERE retention_rules.retention_rule IS DISTINCT FROM EXCLUDED.retention_rule;
  RETURN child;
END;
$$;
