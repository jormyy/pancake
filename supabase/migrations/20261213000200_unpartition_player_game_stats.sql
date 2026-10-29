BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='300s';
SET LOCAL work_mem='32MB';
SET LOCAL maintenance_work_mem='64MB';
SET LOCAL search_path='';
CREATE TABLE IF NOT EXISTS private.player_stats_unpartition_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),data jsonb NOT NULL);
REVOKE ALL ON private.player_stats_unpartition_state FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE
  original regclass:='public.player_game_stats';
  original_type oid;
  original_array_type oid;
  original_owner text;
  original_comment text;
  original_rls boolean;
  original_force_rls boolean;
  original_replica "char";
  original_options text[];
  started timestamptz:=clock_timestamp();
  locked timestamptz;
  copied_at timestamptz;
  checkpoint timestamptz:=clock_timestamp();
  item_started timestamptz;
  copied bigint;
  expected bigint;
  mismatch boolean;
  insert_columns text;
  children oid[];
  definitions jsonb;
  views jsonb;
  indexes jsonb;
  triggers jsonb;
  constraints jsonb;
  incoming jsonb;
  policies jsonb;
  grants jsonb;
  column_grants jsonb;
  publications jsonb;
  item record;
  privilege record;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid=original)='r' AND EXISTS(SELECT 1 FROM private.player_stats_unpartition_state) THEN UPDATE private.player_stats_unpartition_state SET data=jsonb_set(jsonb_set(data,'{started}',to_jsonb(started)),'{resumed}','true'); RETURN; END IF;
  IF (SELECT relkind FROM pg_class WHERE oid=original)<>'p' THEN
    RAISE EXCEPTION 'Expected partitioned player_game_stats';
  END IF;
  SELECT reltype,relowner::regrole::text,obj_description(oid,'pg_class'),relrowsecurity,relforcerowsecurity,relreplident,reloptions
    INTO original_type,original_owner,original_comment,original_rls,original_force_rls,original_replica,original_options
    FROM pg_class WHERE oid=original;
  SELECT typarray INTO original_array_type FROM pg_type WHERE oid=original_type;
  SELECT array_agg(relid::oid) INTO children FROM pg_partition_tree(original) WHERE relid<>original;
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) FILTER(WHERE attgenerated='')
    INTO insert_columns FROM pg_attribute WHERE attrelid=original AND attnum>0 AND NOT attisdropped;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.oid,'identity',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
    'owner',p.proowner::regrole::text,'comment',obj_description(p.oid,'pg_proc'),
    'typed',p.prorettype IN(original_type,original_array_type) OR p.proargtypes::oid[]&&ARRAY[original_type,original_array_type] OR COALESCE(p.proallargtypes&&ARRAY[original_type,original_array_type],false),
    'acl',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,'grantable',a.is_grantable)) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)) ORDER BY p.oid),'[]')
    INTO definitions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prokind='f' AND n.nspname IN('public','private','analytics')
      AND p.proname NOT IN('ensure_player_stats_partition','retain_player_game_stats')
      AND (p.prorettype IN(original_type,original_array_type)
        OR p.proargtypes::oid[]&&ARRAY[original_type,original_array_type] OR COALESCE(p.proallargtypes&&ARRAY[original_type,original_array_type],false)
        OR EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
          AND ((d.refclassid='pg_class'::regclass AND d.refobjid=original) OR (d.refclassid='pg_type'::regclass AND d.refobjid IN(original_type,original_array_type)))));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'definition',pg_get_viewdef(c.oid,true),'options',array_to_string(c.reloptions,',')) ORDER BY c.oid),'[]') INTO views
    FROM pg_class c WHERE c.relkind='v' AND EXISTS(SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
      WHERE r.ev_class=c.oid AND d.refclassid='pg_class'::regclass AND d.refobjid=original);
  IF EXISTS(SELECT 1 FROM pg_class c WHERE c.relkind='m' AND EXISTS(SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid WHERE r.ev_class=c.oid AND d.refclassid='pg_class'::regclass AND d.refobjid=original)) THEN
    RAISE EXCEPTION 'A materialized stats view requires an explicit rebuild';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_indexdef(i.indexrelid),
    'signature',substr(pg_get_indexdef(i.indexrelid),strpos(pg_get_indexdef(i.indexrelid),' USING ')),
    'primary',i.indisprimary,'unique',i.indisunique,'clustered',i.indisclustered,'replica',i.indisreplident,
    'comment',obj_description(i.indexrelid,'pg_class'),'constraint',co.conname,'constraintComment',obj_description(co.oid,'pg_constraint')) ORDER BY c.relname) INTO indexes
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid LEFT JOIN pg_constraint co ON co.conindid=i.indexrelid AND co.conrelid=original WHERE i.indrelid=original;
  SELECT jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid,true),'enabled',tgenabled,'comment',obj_description(oid,'pg_trigger')) ORDER BY tgname) INTO triggers
    FROM pg_trigger WHERE tgrelid=original AND NOT tgisinternal;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true),'comment',obj_description(oid,'pg_constraint'),'validated',convalidated) ORDER BY conname),'[]') INTO constraints
    FROM pg_constraint WHERE conrelid=original AND contype='f';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,'definition',pg_get_constraintdef(oid,true),'comment',obj_description(oid,'pg_constraint'),'validated',convalidated) ORDER BY conrelid,conname),'[]') INTO incoming
    FROM pg_constraint WHERE confrelid=original AND contype='f' AND conparentid=0;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',polname,'definition',format('CREATE POLICY %I ON public.player_game_stats AS %s FOR %s TO %s%s%s',polname,
    CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
    CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
    (SELECT string_agg(CASE WHEN role=0 THEN 'PUBLIC' ELSE role::regrole::text END,',') FROM unnest(polroles) role),
    CASE WHEN polqual IS NULL THEN '' ELSE ' USING ('||pg_get_expr(polqual,polrelid)||')' END,
    CASE WHEN polwithcheck IS NULL THEN '' ELSE ' WITH CHECK ('||pg_get_expr(polwithcheck,polrelid)||')' END),
    'comment',obj_description(oid,'pg_policy')) ORDER BY polname),'[]') INTO policies FROM pg_policy WHERE polrelid=original;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') INTO grants
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=original;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('column',c.attname,'role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') INTO column_grants
    FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE c.attrelid=original AND c.attnum>0 AND NOT c.attisdropped;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.pubname,'columns',(SELECT string_agg(quote_ident(a.attname),',' ORDER BY ordinality) FROM unnest(r.prattrs) WITH ORDINALITY attr(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=original AND a.attnum=attr.attnum),'filter',pg_get_expr(r.prqual,r.prrelid))),'[]') INTO publications
    FROM pg_publication_rel r JOIN pg_publication p ON p.oid=r.prpubid WHERE r.prrelid=original;

  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','catalog','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  CREATE TABLE public.player_game_stats_rebuild (LIKE public.player_game_stats INCLUDING ALL EXCLUDING INDEXES);
  IF original_options IS NOT NULL THEN EXECUTE 'ALTER TABLE public.player_game_stats_rebuild SET ('||array_to_string(original_options,',')||')'; END IF;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','prepare_heap','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(policies) x(name text,definition text,"comment" text) LOOP
    EXECUTE replace(item.definition,' ON public.player_game_stats ',' ON public.player_game_stats_rebuild ');
    EXECUTE format('COMMENT ON POLICY %I ON public.player_game_stats_rebuild IS %L',item.name,item."comment");
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','policies','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(triggers) x(name text,definition text,enabled text,"comment" text) LOOP
    EXECUTE replace(item.definition,' ON public.player_game_stats ',' ON public.player_game_stats_rebuild ');
    EXECUTE format('ALTER TABLE public.player_game_stats_rebuild %s TRIGGER %I',CASE item.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END,item.name);
    EXECUTE format('COMMENT ON TRIGGER %I ON public.player_game_stats_rebuild IS %L',item.name,item."comment");
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','triggers','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  EXECUTE format('ALTER TABLE public.player_game_stats_rebuild OWNER TO %s',original_owner);
  IF original_rls THEN ALTER TABLE public.player_game_stats_rebuild ENABLE ROW LEVEL SECURITY; END IF;
  IF original_force_rls THEN ALTER TABLE public.player_game_stats_rebuild FORCE ROW LEVEL SECURITY; END IF;
  IF original_replica<>'i' THEN EXECUTE 'ALTER TABLE public.player_game_stats_rebuild REPLICA IDENTITY '||CASE original_replica WHEN 'f' THEN 'FULL' WHEN 'n' THEN 'NOTHING' ELSE 'DEFAULT' END; END IF;
  REVOKE ALL ON public.player_game_stats_rebuild FROM PUBLIC,anon,authenticated,service_role;
  FOR item IN SELECT * FROM jsonb_to_recordset(grants) x(role text,privilege text,grantable boolean) LOOP
    EXECUTE format('GRANT %s ON public.player_game_stats_rebuild TO %s%s',item.privilege,item.role,CASE WHEN item.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  FOR item IN SELECT * FROM jsonb_to_recordset(column_grants) x("column" text,role text,privilege text,grantable boolean) LOOP
    EXECUTE format('GRANT %s (%I) ON public.player_game_stats_rebuild TO %s%s',item.privilege,item."column",item.role,CASE WHEN item.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  EXECUTE format('COMMENT ON TABLE public.player_game_stats_rebuild IS %L',original_comment);
  ALTER TABLE public.player_game_stats_rebuild DISABLE TRIGGER ALL;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','grants','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  LOCK TABLE public.player_game_stats IN SHARE MODE;
  locked:=clock_timestamp();
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','lock_acquired','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  EXECUTE format('WITH source_rows AS MATERIALIZED (SELECT * FROM public.player_game_stats), copied_rows AS (INSERT INTO public.player_game_stats_rebuild(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM source_rows RETURNING *) SELECT (SELECT count(*) FROM source_rows),(SELECT count(*) FROM copied_rows),EXISTS(SELECT * FROM source_rows EXCEPT ALL SELECT * FROM copied_rows)',insert_columns,insert_columns)
    INTO expected,copied,mismatch;
  copied_at:=clock_timestamp();
  IF copied<>expected OR mismatch THEN RAISE EXCEPTION 'Stats copy differs: % versus %',copied,expected; END IF;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','copy_verify','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  SELECT jsonb_agg(entry.value||jsonb_build_object('replacement','pgs_rebuild_'||md5(entry.value->>'name'),'replacementConstraint',CASE WHEN entry.value->>'constraint' IS NOT NULL THEN 'pgs_rebuild_'||md5(entry.value->>'name') END)) INTO indexes FROM jsonb_array_elements(indexes) entry(value);
  FOR item IN SELECT * FROM jsonb_to_recordset(indexes) x(name text,replacement text,signature text,"primary" boolean,"unique" boolean,"constraint" text) LOOP
    item_started:=clock_timestamp();
    EXECUTE format('CREATE %s INDEX %I ON public.player_game_stats_rebuild%s',CASE WHEN item."unique" THEN 'UNIQUE' ELSE '' END,item.replacement,item.signature);
    IF item."constraint" IS NOT NULL THEN EXECUTE format('ALTER TABLE public.player_game_stats_rebuild ADD CONSTRAINT %I %s USING INDEX %I',item.replacement,CASE WHEN item."primary" THEN 'PRIMARY KEY' ELSE 'UNIQUE' END,item.replacement); END IF;
    RAISE NOTICE 'stats_item %',jsonb_build_object('phase','index','name',item.name,'ms',extract(epoch FROM clock_timestamp()-item_started)*1000);
  END LOOP;
  ALTER TABLE public.player_game_stats_rebuild ADD CONSTRAINT player_game_stats_id_unique UNIQUE(id);
  ALTER TABLE public.player_game_stats_rebuild ENABLE TRIGGER ALL;
  FOR item IN SELECT * FROM jsonb_to_recordset(triggers) x(name text,enabled text) WHERE enabled<>'O' LOOP
    EXECUTE format('ALTER TABLE public.player_game_stats_rebuild %s TRIGGER %I',CASE item.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' ELSE 'ENABLE REPLICA' END,item.name);
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','bulk_indexes','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(incoming) x("table" text,name text,definition text,"comment" text) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item."table",item.name);
  END LOOP;
  ALTER TABLE public.player_game_stats RENAME TO player_game_stats_partitioned_old;
  ALTER TABLE public.player_game_stats_rebuild RENAME TO player_game_stats;

  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','swap','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(definitions) x(id oid,identity text,definition text,owner text,"comment" text,typed boolean,acl jsonb) ORDER BY typed DESC,id LOOP
    item_started:=clock_timestamp();
    EXECUTE item.definition;
    RAISE NOTICE 'stats_item %',jsonb_build_object('phase','function','name',item.identity,'ms',extract(epoch FROM clock_timestamp()-item_started)*1000);
    IF item.typed THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO %s',item.identity,item.owner);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',item.identity);
      FOR privilege IN SELECT * FROM jsonb_to_recordset(item.acl) x(role text,grantable boolean) LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',item.identity,privilege.role,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
      EXECUTE format('COMMENT ON FUNCTION %s IS %L',item.identity,item."comment");
    END IF;
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','functions','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(views) x(name text,definition text,options text) LOOP
    EXECUTE format('CREATE OR REPLACE VIEW %s%s AS %s',item.name,CASE WHEN item.options IS NULL THEN '' ELSE ' WITH ('||item.options||')' END,item.definition);
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','views','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(definitions) x(id oid,typed boolean) WHERE typed LOOP
    EXECUTE format('DROP FUNCTION %s',item.id::regprocedure);
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','drop_old_functions','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(publications) x(name text,columns text,filter text) LOOP
    EXECUTE format('ALTER PUBLICATION %I DROP TABLE public.player_game_stats_partitioned_old',item.name);
    EXECUTE format('ALTER PUBLICATION %I ADD TABLE public.player_game_stats%s%s',item.name,
      CASE WHEN item.columns IS NULL THEN '' ELSE ' ('||item.columns||')' END,
      CASE WHEN item.filter IS NULL THEN '' ELSE ' WHERE ('||item.filter||')' END);
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','publication','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  DELETE FROM private.retention_status WHERE relation_name IN(SELECT oid::regclass::text FROM unnest(children) oid) OR relation_name='private.player_stats_partitions';
  DELETE FROM private.retention_rules WHERE relation_name IN(SELECT oid::regclass::text FROM unnest(children) oid) OR relation_name='private.player_stats_partitions';
  DELETE FROM private.log_partitions WHERE parent_table=original OR partition_table::oid=ANY(children);
  DELETE FROM private.partitioned_log_policies WHERE parent_table=original;
  UPDATE private.retention_rules SET worker=NULL,retention_rule='Durable scoring history; no automatic deletion or partition maintenance' WHERE relation_name='public.player_game_stats';
  DROP TABLE private.player_stats_partitions;
  DROP TABLE public.player_game_stats_partitioned_old;

  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','retire_old_table','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(indexes) x(name text,replacement text,"constraint" text,"replacementConstraint" text,"comment" text,"constraintComment" text,clustered boolean,replica boolean) LOOP
    IF item."constraint" IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.player_game_stats RENAME CONSTRAINT %I TO %I',item."replacementConstraint",item."constraint");
    ELSE
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I',item.replacement,item.name);
    END IF;
    EXECUTE format('COMMENT ON INDEX public.%I IS %L',item.name,item."comment");
    IF item."constraint" IS NOT NULL THEN EXECUTE format('COMMENT ON CONSTRAINT %I ON public.player_game_stats IS %L',item."constraint",item."constraintComment"); END IF;
    IF item.clustered THEN EXECUTE format('ALTER TABLE public.player_game_stats CLUSTER ON %I',item.name); END IF;
    IF item.replica THEN EXECUTE format('ALTER TABLE public.player_game_stats REPLICA IDENTITY USING INDEX %I',item.name); END IF;
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','index_names','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(constraints) x(name text,definition text,"comment" text) LOOP
    EXECUTE format('ALTER TABLE public.player_game_stats ADD CONSTRAINT %I %s',item.name,regexp_replace(item.definition,' NOT VALID$','')||' NOT VALID');
    EXECUTE format('COMMENT ON CONSTRAINT %I ON public.player_game_stats IS %L',item.name,item."comment");
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','outgoing_fks_not_valid','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  FOR item IN SELECT * FROM jsonb_to_recordset(incoming) x("table" text,name text,definition text,"comment" text) LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item."table",item.name,regexp_replace(item.definition,' NOT VALID$','')||' NOT VALID');
    EXECUTE format('COMMENT ON CONSTRAINT %I ON %s IS %L',item.name,item."table",item."comment");
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','incoming_fks_not_valid','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  INSERT INTO private.player_stats_unpartition_state(data) VALUES(jsonb_build_object('constraints',constraints,'incoming',incoming,'started',started,'locked',locked,'rows',copied));
  IF clock_timestamp()-started>interval '300 seconds' THEN RAISE EXCEPTION 'Stats rebuild exceeds 300 seconds'; END IF;
  RAISE NOTICE 'player_stats_rebuild %',jsonb_build_object('rows',copied,'totalMs',extract(epoch FROM clock_timestamp()-started)*1000,
    'writerLockMs',extract(epoch FROM clock_timestamp()-locked)*1000,'copyAndVerifyMs',extract(epoch FROM copied_at-locked)*1000);
END;
$$;

DROP FUNCTION IF EXISTS private.ensure_player_stats_partition(integer);
DROP FUNCTION IF EXISTS private.retain_player_game_stats(timestamptz);

CREATE OR REPLACE FUNCTION private.guard_player_stats_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' AS $$
DECLARE old_id uuid; old_game uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.game_id) IS NOT DISTINCT FROM ROW(OLD.id,OLD.game_id) THEN RETURN NEW; END IF;
    old_id:=OLD.id; old_game:=OLD.game_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pgs-id:'||NEW.id::text,0));
  IF EXISTS(SELECT FROM public.player_game_stats row WHERE row.id=NEW.id AND row.game_id<>NEW.game_id
    AND (old_id IS NULL OR ROW(row.id,row.game_id) IS DISTINCT FROM ROW(old_id,old_game))) THEN
    RAISE EXCEPTION 'Duplicate player stats identity across seasons' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.drop_expired_log_partitions(p_parent regclass,p_cutoff timestamptz,p_now timestamptz DEFAULT now())
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE part record; removed bigint:=0; counted bigint; month_offset integer;
BEGIN
  PERFORM 1 FROM private.partitioned_log_policies policy JOIN pg_catalog.pg_class relation ON relation.oid=policy.parent_table AND relation.relkind='p' WHERE policy.parent_table=p_parent;
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

NOTIFY pgrst,'reload schema';

CREATE OR REPLACE FUNCTION public.view_game_day(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; selected date; games jsonb; started_teams jsonb; opponents jsonb; stats jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  selected := COALESCE((p_params->>'date')::date, (context->>'today')::date);
  WITH slate AS MATERIALIZED (SELECT * FROM public.nba_games WHERE game_date = selected), teams AS (
    SELECT id, home_team AS team, away_team AS opponent, true AS home, status IN ('InProgress','Final') OR game_time <= now() OR started_at <= now() AS started FROM slate
    UNION ALL SELECT id, away_team, home_team, false, status IN ('InProgress','Final') OR game_time <= now() OR started_at <= now() FROM slate
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'nba_game_id', nba_game_id, 'home_team', home_team,
      'away_team', away_team, 'home_score', home_score, 'away_score', away_score, 'status', status,
      'game_status_text', game_status_text, 'game_date', game_date) ORDER BY game_time, id) FROM slate WHERE nba_game_id LIKE '002%'), '[]'),
    COALESCE(jsonb_agg(DISTINCT team) FILTER (WHERE started AND team IS NOT NULL), '[]'),
    COALESCE(jsonb_object_agg(team, jsonb_build_object('opponent', opponent, 'isHome', home) ORDER BY id) FILTER (WHERE team IS NOT NULL AND opponent IS NOT NULL), '{}')
  INTO games, started_teams, opponents FROM teams;
  SELECT COALESCE(jsonb_object_agg(stat.player_id::text, jsonb_build_object('points', COALESCE(stat.points, 0),
    'rebounds', COALESCE(stat.rebounds, 0), 'assists', COALESCE(stat.assists, 0), 'steals', COALESCE(stat.steals, 0),
    'blocks', COALESCE(stat.blocks, 0), 'turnovers', stat.turnovers, 'threeMade', COALESCE(stat.three_pointers_made, 0),
    'fgMade', COALESCE(stat.field_goals_made, 0), 'fgAttempted', COALESCE(stat.field_goals_attempted, 0),
    'ftMade', COALESCE(stat.free_throws_made, 0), 'ftAttempted', COALESCE(stat.free_throws_attempted, 0),
    'fouls', COALESCE(stat.personal_fouls, 0), 'doubleDouble', COALESCE(stat.double_double, false),
    'tripleDouble', COALESCE(stat.triple_double, false), 'minutesPlayed', stat.minutes_played, 'didNotPlay', COALESCE(stat.did_not_play, false)) ORDER BY stat.id), '{}')
  INTO stats FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id AND game.nba_game_id LIKE '002%'
  WHERE stat.game_date = selected AND stat.player_id IN (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_params->'playerIds', '[]')));
  RETURN jsonb_build_object('games', games, 'startedTeams', started_teams, 'teamMatchups', opponents, 'liveStats', stats);
END;
$$;

COMMIT;
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='300s';
SET LOCAL search_path='';
DO $$
DECLARE state jsonb; item record; started timestamptz:=clock_timestamp(); checkpoint timestamptz:=clock_timestamp(); phase_started timestamptz;
BEGIN
  SELECT data INTO STRICT state FROM private.player_stats_unpartition_state;
  IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.player_game_stats'::regclass AND mode IN('ShareLock','AccessExclusiveLock')) THEN RAISE EXCEPTION 'Stats copy lock remains during validation'; END IF;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase',CASE WHEN COALESCE((state->>'resumed')::boolean,false) THEN 'resumed_validation' ELSE 'lock_released' END,'ms',CASE WHEN COALESCE((state->>'resumed')::boolean,false) THEN 0 ELSE extract(epoch FROM clock_timestamp()-(state->>'locked')::timestamptz)*1000 END,'elapsedMs',extract(epoch FROM clock_timestamp()-(state->>'started')::timestamptz)*1000);
  FOR item IN SELECT * FROM jsonb_to_recordset(state->'constraints') x(name text,validated boolean) WHERE validated LOOP
    EXECUTE format('ALTER TABLE public.player_game_stats VALIDATE CONSTRAINT %I',item.name);
    RAISE NOTICE 'stats_item %',jsonb_build_object('phase','validate_outgoing_fk','name',item.name,'ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000);
    checkpoint:=clock_timestamp();
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','validate_outgoing_fks','ms',extract(epoch FROM clock_timestamp()-started)*1000);
  checkpoint:=clock_timestamp();
  phase_started:=checkpoint;
  FOR item IN SELECT * FROM jsonb_to_recordset(state->'incoming') x("table" text,name text,validated boolean) WHERE validated LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I',item."table",item.name);
    RAISE NOTICE 'stats_item %',jsonb_build_object('phase','validate_incoming_fk','name',item.name,'ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000);
    checkpoint:=clock_timestamp();
  END LOOP;
  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','validate_incoming_fks','ms',extract(epoch FROM clock_timestamp()-phase_started)*1000);
  IF clock_timestamp()-(state->>'started')::timestamptz>interval '300 seconds' THEN RAISE EXCEPTION 'Stats migration exceeds 300 seconds'; END IF;
END;
$$;
DROP TABLE private.player_stats_unpartition_state;
COMMIT;
