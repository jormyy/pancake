SET lock_timeout='3s';
SET statement_timeout='2min';
SET search_path=pg_catalog;
DO $$
DECLARE target record; original regclass; index_defs text[]; foreign_defs text[]; trigger_defs text[]; policy_defs text[]; grants jsonb;
  column_grants jsonb; sequence_grants jsonb; sequence_name text; sequence_last bigint; sequence_called boolean; new_sequence text; column_names text;
  month_start date; month_end date; owner_name text; original_rls boolean; original_force boolean; definition text; privilege record;
BEGIN
  FOR target IN SELECT schema_name,table_name,time_column,identity_column FROM (VALUES ('public','edge_invocations','queued_at','id'),('public','league_events','created_at','id')) AS targets(schema_name,table_name,time_column,identity_column) LOOP
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
    SELECT array_agg(format('CREATE POLICY %I ON %s AS %s FOR %s TO %s%s%s',polname,original,
      CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      (SELECT string_agg(CASE WHEN role_id=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(role_id)) END,',') FROM unnest(polroles) role_id),
      CASE WHEN polqual IS NULL THEN '' ELSE ' USING ('||pg_get_expr(polqual,polrelid)||')' END,
      CASE WHEN polwithcheck IS NULL THEN '' ELSE ' WITH CHECK ('||pg_get_expr(polwithcheck,polrelid)||')' END))
      INTO policy_defs FROM pg_policy WHERE polrelid=original;
    SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO grants
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=original;
    SELECT jsonb_agg(jsonb_build_object('column_name',attribute.attname,'role',CASE WHEN column_privilege.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(column_privilege.grantee) END,
      'privilege',column_privilege.privilege_type,'grantable',column_privilege.is_grantable)) INTO column_grants
    FROM pg_attribute attribute CROSS JOIN LATERAL aclexplode(attribute.attacl) column_privilege
    WHERE attribute.attrelid=original AND attribute.attnum>0 AND NOT attribute.attisdropped;
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
    FOREACH definition IN ARRAY coalesce(index_defs,'{}') LOOP
      IF target.table_name='edge_invocations' AND definition LIKE 'CREATE UNIQUE INDEX %' THEN
        definition:=replace(definition,'(invocation_key)','(invocation_key, queued_at)');
      END IF;
      EXECUTE definition;
    END LOOP;
    FOREACH definition IN ARRAY coalesce(policy_defs,'{}') LOOP EXECUTE definition; END LOOP;
    FOREACH definition IN ARRAY coalesce(foreign_defs,'{}') LOOP EXECUTE format('ALTER TABLE %s %s',original,definition); END LOOP;
    FOREACH definition IN ARRAY coalesce(trigger_defs,'{}') LOOP EXECUTE definition; END LOOP;
    EXECUTE format('ALTER TABLE %s OWNER TO %I',original,owner_name);
    IF original_rls THEN EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',original); END IF;
    IF original_force THEN EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',original); END IF;
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,anon,authenticated,service_role',original);
    FOR privilege IN SELECT a.role,a.privilege,a.grantable FROM jsonb_to_recordset(grants) AS a(role text,privilege text,grantable boolean) LOOP
      EXECUTE format('GRANT %s ON %s TO %s%s',privilege.privilege,original,CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    FOR privilege IN SELECT a.column_name,a.role,a.privilege,a.grantable FROM jsonb_to_recordset(column_grants)
      AS a(column_name text,role text,privilege text,grantable boolean) LOOP
      EXECUTE format('GRANT %s(%I) ON %s TO %s%s',privilege.privilege,privilege.column_name,original,
        CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
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

DO $$ DECLARE target record; BEGIN
  FOR target IN SELECT policy.parent_table,policy.identity_column,relation.relname
    FROM private.partitioned_log_policies policy JOIN pg_class relation ON relation.oid=policy.parent_table
    WHERE policy.parent_table IN ('public.edge_invocations'::regclass,'public.league_events'::regclass) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s',target.relname||'_global_identity',target.parent_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %s FOR EACH ROW EXECUTE FUNCTION private.guard_partition_identity(%L,%L,%L)',
      target.relname||'_global_identity',target.identity_column,target.parent_table,target.parent_table::text,target.identity_column,target.relname||'_pkey');
  END LOOP;
END; $$;
DROP TRIGGER IF EXISTS edge_invocations_global_invocation_key ON public.edge_invocations;
CREATE TRIGGER edge_invocations_global_invocation_key BEFORE INSERT OR UPDATE OF invocation_key ON public.edge_invocations
FOR EACH ROW EXECUTE FUNCTION private.guard_partition_identity('public.edge_invocations','invocation_key','edge_invocations_invocation_key');
DO $$ DECLARE child regclass; BEGIN
  FOR child IN SELECT inhrelid FROM pg_inherits WHERE inhparent IN ('public.edge_invocations'::regclass,'public.league_events'::regclass)
  LOOP EXECUTE format('GRANT SELECT ON %s TO service_role',child); END LOOP;
END; $$;
RESET search_path;

CREATE OR REPLACE FUNCTION private.drop_expired_invocation_partitions(p_now timestamptz DEFAULT now())
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE keep_ids bigint[]; part record; eligible boolean; removed bigint:=0; counted bigint; month_offset integer;
BEGIN
  FOR month_offset IN 0..2 LOOP
    PERFORM private.ensure_log_partition('public.edge_invocations',((p_now AT TIME ZONE 'UTC')::date+make_interval(months=>month_offset))::date);
  END LOOP;
  SELECT array_agg(latest.id) INTO keep_ids FROM (
    (SELECT DISTINCT ON (function_name) id FROM public.edge_invocations
      WHERE status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM 'failed'
        AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL)
        AND worker_status IS DISTINCT FROM 'running'
      ORDER BY function_name,queued_at DESC,id DESC)
    UNION ALL
    (SELECT DISTINCT ON (function_name) id FROM public.edge_invocations
      WHERE (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status='failed')
        AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL OR worker_status='failed')
        AND worker_status IS DISTINCT FROM 'running'
      ORDER BY function_name,queued_at DESC,id DESC)
  ) latest;
  FOR part IN SELECT partition_table FROM private.log_partitions
    WHERE parent_table='public.edge_invocations'::regclass AND upper_bound::timestamp AT TIME ZONE 'UTC'<=p_now-interval '30 days'
    ORDER BY lower_bound LIMIT 12 LOOP
    EXECUTE format($query$
      SELECT NOT EXISTS(SELECT FROM %s row WHERE row.id=ANY($2) OR NOT coalesce(
        (row.status_code BETWEEN 200 AND 299 AND row.error_message IS NULL AND row.worker_status IS DISTINCT FROM 'failed'
          AND row.reconciled_at<$1-interval '7 days' AND (row.worker_started_at IS NULL OR row.worker_finished_at IS NOT NULL)
          AND row.worker_status IS DISTINCT FROM 'running')
        OR ((row.status_code IS NULL OR row.status_code NOT BETWEEN 200 AND 299 OR row.error_message IS NOT NULL OR row.worker_status='failed')
          AND row.reconciled_at<$1-interval '30 days' AND (row.worker_started_at IS NULL OR row.worker_finished_at IS NOT NULL OR row.worker_status='failed')
          AND row.worker_status IS DISTINCT FROM 'running'),false))
    $query$,part.partition_table) INTO eligible USING p_now,coalesce(keep_ids,'{}'::bigint[]);
    IF NOT eligible THEN CONTINUE; END IF;
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

CREATE OR REPLACE FUNCTION private.retain_edge_invocations(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_total bigint:=0; v_outcome integer; v_condition text; v_age interval;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.edge_invocations r
    WHERE (r.reconciled_at IS NULL OR r.worker_status='running')
      AND GREATEST(r.queued_at,r.worker_started_at)<p_now-interval '30 days'
    ORDER BY r.queued_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) UPDATE public.edge_invocations r SET reconciled_at=COALESCE(r.reconciled_at,p_now),
    worker_status='failed',worker_finished_at=COALESCE(r.worker_finished_at,p_now),
    error_message=COALESCE(r.error_message,'Invocation remains unfinished after 30 days')
  FROM stale WHERE r.id=stale.id;
  v_total:=private.drop_expired_invocation_partitions(p_now);
  FOR v_outcome IN 1..2 LOOP
    IF v_outcome=1 THEN
      v_condition:='status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM ''failed'' AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM ''running''';
      v_age:=interval '7 days';
    ELSE
      v_condition:='(status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status=''failed'') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL OR worker_status=''failed'') AND worker_status IS DISTINCT FROM ''running''';
      v_age:=interval '30 days';
    END IF;
    EXECUTE format($query$
      WITH victims AS (
        SELECT r.id FROM public.edge_invocations r
        WHERE %1$s AND r.reconciled_at<$1-$2
          AND r.id IS DISTINCT FROM (SELECT newest.id FROM public.edge_invocations newest
            WHERE newest.function_name=r.function_name AND %1$s
            ORDER BY newest.queued_at DESC,newest.id DESC LIMIT 1)
        ORDER BY r.reconciled_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM public.edge_invocations r USING victims v WHERE r.id=v.id
    $query$,v_condition) USING p_now,v_age;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
  END LOOP;
  RETURN jsonb_build_object('public.edge_invocations',v_total);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_league_events(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE removed bigint; dropped bigint;
BEGIN
  dropped:=private.drop_expired_log_partitions('public.league_events',p_now-interval '2 years',p_now);
  WITH victims AS (
    SELECT id FROM public.league_events WHERE created_at<p_now-interval '2 years'
    ORDER BY created_at,id LIMIT 5000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.league_events row USING victims WHERE row.id=victims.id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN jsonb_build_object('public.league_events',removed+dropped);
END;
$$;

ALTER FUNCTION private.drop_expired_invocation_partitions(timestamptz) OWNER TO postgres;
ALTER FUNCTION private.retain_league_events(timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.drop_expired_invocation_partitions(timestamptz),private.retain_league_events(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.retention_rules(relation_name,retention_rule,worker,run_order)
VALUES('public.league_events','Two years; drop expired complete months; delete at most 5000 boundary rows','retain_league_events',165)
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule,worker=EXCLUDED.worker,run_order=EXCLUDED.run_order;
UPDATE private.retention_rules SET retention_rule='Success seven days; failures thirty days; preserve newest outcome per function; drop eligible complete months; bounded fallback'
WHERE relation_name='public.edge_invocations';
INSERT INTO private.retention_rules(relation_name,retention_rule)
SELECT child.oid::regclass::text,'Partition of '||parent.oid::regclass::text||'; retention follows its parent'
FROM pg_inherits inherited JOIN private.partitioned_log_policies policy ON policy.parent_table=inherited.inhparent
JOIN pg_class child ON child.oid=inherited.inhrelid JOIN pg_class parent ON parent.oid=inherited.inhparent
WHERE parent.oid IN ('public.league_events'::regclass,'public.edge_invocations'::regclass)
ON CONFLICT(relation_name) DO NOTHING;
NOTIFY pgrst,'reload schema';
