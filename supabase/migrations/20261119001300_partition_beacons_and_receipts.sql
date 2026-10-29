SET lock_timeout='3s';
SET statement_timeout='2min';
CREATE TABLE IF NOT EXISTS private.partitioned_log_policies(parent_table regclass PRIMARY KEY,time_column name NOT NULL,identity_column name NOT NULL);
CREATE TABLE IF NOT EXISTS private.log_partitions(parent_table regclass NOT NULL,partition_table regclass PRIMARY KEY,lower_bound date NOT NULL,upper_bound date NOT NULL,UNIQUE(parent_table,lower_bound),CHECK(lower_bound<upper_bound));
ALTER TABLE private.partitioned_log_policies OWNER TO postgres;
ALTER TABLE private.log_partitions OWNER TO postgres;
ALTER TABLE private.partitioned_log_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.log_partitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.partitioned_log_policies,private.log_partitions FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.guard_partition_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE identity_value text; present boolean;
BEGIN
  identity_value:=to_jsonb(NEW)->>TG_ARGV[1];
  IF identity_value IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND identity_value IS NOT DISTINCT FROM to_jsonb(OLD)->>TG_ARGV[1] THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||identity_value,48191));
  EXECUTE format('SELECT EXISTS(SELECT FROM %s stored WHERE stored.%I=($1).%I)',TG_ARGV[0]::regclass,TG_ARGV[1],TG_ARGV[1])
    INTO present USING NEW;
  IF present THEN
    RAISE unique_violation USING MESSAGE='Duplicate partitioned identity',CONSTRAINT=TG_ARGV[2];
  END IF;
  RETURN NEW;
END;
$$;

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

CREATE OR REPLACE FUNCTION private.drop_expired_log_partitions(p_parent regclass,p_cutoff timestamptz,p_now timestamptz DEFAULT now())
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE part record; removed bigint:=0; counted bigint; month_offset integer;
BEGIN
  PERFORM 1 FROM private.partitioned_log_policies WHERE parent_table=p_parent;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown partition retention parent'; END IF;
  FOR month_offset IN 0..2 LOOP
    PERFORM private.ensure_log_partition(p_parent,((p_now AT TIME ZONE 'UTC')::date+make_interval(months=>month_offset))::date);
  END LOOP;
  FOR part IN SELECT partition_table FROM private.log_partitions WHERE parent_table=p_parent
    AND upper_bound::timestamp AT TIME ZONE 'UTC'<=p_cutoff ORDER BY lower_bound LIMIT 12 LOOP
    EXECUTE format('SELECT count(*) FROM %s',part.partition_table) INTO counted;
    DELETE FROM private.retention_status WHERE relation_name=part.partition_table::text;
    DELETE FROM private.retention_rules WHERE relation_name=part.partition_table::text;
    EXECUTE format('DROP TABLE %s',part.partition_table);
    DELETE FROM private.log_partitions WHERE partition_table=part.partition_table;
    removed:=removed+counted;
  END LOOP;
  RETURN removed;
END;
$$;

ALTER FUNCTION private.guard_partition_identity() OWNER TO postgres;
ALTER FUNCTION private.ensure_log_partition(regclass,date) OWNER TO postgres;
ALTER FUNCTION private.drop_expired_log_partitions(regclass,timestamptz,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.guard_partition_identity(),private.ensure_log_partition(regclass,date),private.drop_expired_log_partitions(regclass,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE target record; original regclass; index_defs text[]; foreign_defs text[]; trigger_defs text[]; grants jsonb;
  sequence_grants jsonb; sequence_name text; sequence_last bigint; sequence_called boolean; new_sequence text; column_names text;
  month_start date; month_end date; owner_name text; original_rls boolean; original_force boolean; definition text; privilege record;
BEGIN
  FOR target IN SELECT schema_name,table_name,time_column,identity_column FROM (VALUES ('public','perf_beacons','received_at','id'),('private','request_receipts','created_at','request_id')) AS targets(schema_name,table_name,time_column,identity_column) LOOP
    original:=format('%I.%I',target.schema_name,target.table_name)::regclass;
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',original);
    IF (SELECT relkind FROM pg_class WHERE oid=original)='p' THEN
      IF NOT EXISTS(SELECT FROM private.partitioned_log_policies WHERE parent_table=original AND time_column=target.time_column AND identity_column=target.identity_column) THEN
        RAISE EXCEPTION 'Existing partition policy differs for %',original;
      END IF;
      CONTINUE;
    END IF;
    SELECT pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity INTO owner_name,original_rls,original_force FROM pg_class WHERE oid=original;
    SELECT array_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) INTO index_defs FROM pg_index WHERE indrelid=original AND NOT indisprimary;
    SELECT array_agg('ADD CONSTRAINT '||quote_ident(conname)||' '||pg_get_constraintdef(oid)) INTO foreign_defs FROM pg_constraint WHERE conrelid=original AND contype='f';
    SELECT array_agg(pg_get_triggerdef(oid) ORDER BY tgname) INTO trigger_defs FROM pg_trigger WHERE tgrelid=original AND NOT tgisinternal;
    SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO grants
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=original;
    sequence_name:=pg_get_serial_sequence(original::text,target.identity_column);
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('SELECT last_value,is_called FROM %s',sequence_name) INTO sequence_last,sequence_called;
      SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO sequence_grants
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=sequence_name::regclass;
    END IF;
    EXECUTE format('SELECT coalesce(date_trunc(''month'',min(%I) AT TIME ZONE ''UTC'')::date,date_trunc(''month'',now() AT TIME ZONE ''UTC'')::date),greatest(coalesce(date_trunc(''month'',max(%I) AT TIME ZONE ''UTC'')::date,current_date),(date_trunc(''month'',now() AT TIME ZONE ''UTC'')+interval ''2 months'')::date) FROM %s',target.time_column,target.time_column,original) INTO month_start,month_end;
    EXECUTE format('ALTER TABLE %s RENAME TO %I',original,target.table_name||'_unpartitioned');
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL EXCLUDING INDEXES) PARTITION BY RANGE (%I)',target.schema_name,target.table_name,target.schema_name,target.table_name||'_unpartitioned',target.time_column);
    original:=format('%I.%I',target.schema_name,target.table_name)::regclass;
    EXECUTE format('ALTER TABLE %s OWNER TO %I',original,owner_name);
    INSERT INTO private.partitioned_log_policies VALUES(original,target.time_column,target.identity_column);
    EXECUTE format('CREATE TABLE %I.%I PARTITION OF %s DEFAULT WITH (fillfactor=90,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.05,autovacuum_vacuum_threshold=50,autovacuum_analyze_threshold=50)',target.schema_name,target.table_name||'_default',original);
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I',target.schema_name,target.table_name||'_default',owner_name);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',target.schema_name,target.table_name||'_default');
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,anon,authenticated,service_role',target.schema_name,target.table_name||'_default');
    WHILE month_start<=month_end LOOP
      PERFORM private.ensure_log_partition(original,month_start);
      month_start:=(month_start+interval '1 month')::date;
    END LOOP;
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO column_names FROM pg_attribute WHERE attrelid=original AND attnum>0 AND NOT attisdropped;
    EXECUTE format('INSERT INTO %s(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM %I.%I',original,column_names,column_names,target.schema_name,target.table_name||'_unpartitioned');
    EXECUTE format('DROP TABLE %I.%I',target.schema_name,target.table_name||'_unpartitioned');
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I PRIMARY KEY (%I,%I)',original,target.table_name||'_pkey',target.identity_column,target.time_column);
    FOREACH definition IN ARRAY coalesce(index_defs,'{}') LOOP EXECUTE definition; END LOOP;
    FOREACH definition IN ARRAY coalesce(foreign_defs,'{}') LOOP EXECUTE format('ALTER TABLE %s %s',original,definition); END LOOP;
    FOREACH definition IN ARRAY coalesce(trigger_defs,'{}') LOOP EXECUTE definition; END LOOP;
    EXECUTE format('ALTER TABLE %s OWNER TO %I',original,owner_name);
    IF original_rls THEN EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',original); END IF;
    IF original_force THEN EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',original); END IF;
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,anon,authenticated,service_role',original);
    FOR privilege IN SELECT a.role,a.privilege,a.grantable FROM jsonb_to_recordset(grants) AS a(role text,privilege text,grantable boolean) LOOP
      EXECUTE format('GRANT %s ON %s TO %s%s',privilege.privilege,original,CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    IF sequence_name IS NOT NULL THEN
      new_sequence:=pg_get_serial_sequence(original::text,target.identity_column);
      PERFORM setval(new_sequence,sequence_last,sequence_called);
      EXECUTE format('ALTER SEQUENCE %s RENAME TO %I',new_sequence,target.table_name||'_'||target.identity_column||'_seq');
      new_sequence:=pg_get_serial_sequence(original::text,target.identity_column);
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC,anon,authenticated,service_role',new_sequence);
      FOR privilege IN SELECT a.role,a.privilege,a.grantable FROM jsonb_to_recordset(sequence_grants) AS a(role text,privilege text,grantable boolean) LOOP
        EXECUTE format('GRANT %s ON SEQUENCE %s TO %s%s',privilege.privilege,new_sequence,CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    END IF;

  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_perf_beacons(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_partitions bigint;
BEGIN
  v_partitions:=private.drop_expired_log_partitions('public.perf_beacons'::regclass,p_now-interval '30 days',p_now);
  WITH victims AS (
    SELECT r.id FROM public.perf_beacons r WHERE r.received_at<p_now-interval '30 days'
    ORDER BY r.received_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.perf_beacons r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.perf_beacons',v_count+v_partitions);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_request_receipts(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_partitions bigint;
BEGIN
  v_partitions:=private.drop_expired_log_partitions('private.request_receipts'::regclass,p_now-interval '7 days',p_now);
  WITH victims AS (
    SELECT r.request_id FROM private.request_receipts r WHERE r.created_at<p_now-interval '7 days'
    ORDER BY r.created_at,r.request_id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.request_receipts r USING victims v WHERE r.request_id=v.request_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.request_receipts',v_count+v_partitions);
END;
$$;

INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
('private.partitioned_log_policies','One policy per partitioned parent; retained with the parent'),
('private.log_partitions','One row per active monthly partition; removed with the partition')
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule
WHERE retention_rules.retention_rule IS DISTINCT FROM EXCLUDED.retention_rule;
UPDATE private.retention_rules SET retention_rule='30 days; drop expired complete months; delete at most 5000 boundary rows'
WHERE relation_name='public.perf_beacons' AND retention_rule IS DISTINCT FROM '30 days; drop expired complete months; delete at most 5000 boundary rows';
UPDATE private.retention_rules SET retention_rule='7 days; drop expired complete months; delete at most 5000 boundary rows'
WHERE relation_name='private.request_receipts' AND retention_rule IS DISTINCT FROM '7 days; drop expired complete months; delete at most 5000 boundary rows';
INSERT INTO private.retention_rules(relation_name,retention_rule)
SELECT child.oid::regclass::text,'Partition of '||parent.oid::regclass::text||'; retention follows its parent'
FROM pg_inherits inherited JOIN private.partitioned_log_policies policy ON policy.parent_table=inherited.inhparent
JOIN pg_class child ON child.oid=inherited.inhrelid JOIN pg_class parent ON parent.oid=inherited.inhparent
ON CONFLICT(relation_name) DO NOTHING;
DO $$ DECLARE target record; BEGIN
  FOR target IN SELECT policy.parent_table,policy.identity_column,n.nspname,c.relname
    FROM private.partitioned_log_policies policy JOIN pg_class c ON c.oid=policy.parent_table
    JOIN pg_namespace n ON n.oid=c.relnamespace LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s',target.relname||'_global_identity',target.parent_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %s FOR EACH ROW EXECUTE FUNCTION private.guard_partition_identity(%L,%L,%L)',target.relname||'_global_identity',target.identity_column,target.parent_table,format('%I.%I',target.nspname,target.relname),target.identity_column,target.relname||'_pkey');
  END LOOP;
END; $$;
DO $$ DECLARE child regclass; BEGIN
  FOR child IN SELECT inherited.inhrelid FROM pg_inherits inherited
    JOIN private.partitioned_log_policies policy ON policy.parent_table=inherited.inhparent
    JOIN pg_class relation ON relation.oid=inherited.inhrelid
    WHERE relation.relnamespace='public'::regnamespace
  LOOP EXECUTE format('GRANT SELECT ON %s TO service_role',child); END LOOP;
END; $$;
NOTIFY pgrst, 'reload schema';
