SET lock_timeout='3s';
SET statement_timeout='2min';
SET search_path=pg_catalog;
CREATE TABLE private.player_stats_partitions(season_year integer NOT NULL,shard integer NOT NULL,partition_table regclass NOT NULL UNIQUE,game_ids uuid[] NOT NULL,PRIMARY KEY(season_year,shard));
ALTER TABLE private.player_stats_partitions OWNER TO postgres;
ALTER TABLE private.player_stats_partitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.player_stats_partitions FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.ensure_player_stats_partition(p_year integer)
RETURNS regclass LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='30s' AS $$
DECLARE plan jsonb; part record; child regclass; states jsonb:='{}'; trigger_state record;
  moved jsonb:='[]'; batch jsonb; column_names text; values_sql text; all_games uuid[]; requested regclass;
BEGIN
  IF p_year IS NULL OR p_year<1 OR p_year>99998 THEN RAISE EXCEPTION 'Invalid stats season' USING ERRCODE='22023'; END IF;
  WITH ranked AS (SELECT id,season_year,((row_number() OVER(PARTITION BY season_year ORDER BY id)-1)/128)::integer AS shard FROM public.nba_games), expected AS (SELECT season_year,shard,array_agg(id ORDER BY id) AS game_ids FROM ranked GROUP BY season_year,shard)
  SELECT jsonb_agg(jsonb_build_object('season_year',coalesce(e.season_year,p.season_year),'shard',coalesce(e.shard,p.shard),
    'child',coalesce(p.partition_table::text,'public.player_game_stats_y'||e.season_year::text||'_p'||e.shard::text),
    'existed',p.partition_table IS NOT NULL,'game_ids',coalesce(to_jsonb(e.game_ids),'[]'::jsonb)) ORDER BY coalesce(e.season_year,p.season_year),coalesce(e.shard,p.shard)) INTO plan
  FROM expected e FULL JOIN private.player_stats_partitions p USING(season_year,shard)
  WHERE e.game_ids IS DISTINCT FROM p.game_ids;
  IF plan IS NULL THEN
    SELECT partition_table INTO requested FROM private.player_stats_partitions WHERE season_year=p_year ORDER BY shard LIMIT 1;
    RETURN coalesce(requested,'public.player_game_stats_default'::regclass);
  END IF;
  LOCK TABLE public.player_game_stats IN ACCESS EXCLUSIVE MODE;
  WITH ranked AS (SELECT id,season_year,((row_number() OVER(PARTITION BY season_year ORDER BY id)-1)/128)::integer AS shard FROM public.nba_games), expected AS (SELECT season_year,shard,array_agg(id ORDER BY id) AS game_ids FROM ranked GROUP BY season_year,shard)
  SELECT jsonb_agg(jsonb_build_object('season_year',coalesce(e.season_year,p.season_year),'shard',coalesce(e.shard,p.shard),
    'child',coalesce(p.partition_table::text,'public.player_game_stats_y'||e.season_year::text||'_p'||e.shard::text),
    'existed',p.partition_table IS NOT NULL,'game_ids',coalesce(to_jsonb(e.game_ids),'[]'::jsonb)) ORDER BY coalesce(e.season_year,p.season_year),coalesce(e.shard,p.shard)) INTO plan
  FROM expected e FULL JOIN private.player_stats_partitions p USING(season_year,shard)
  WHERE e.game_ids IS DISTINCT FROM p.game_ids;
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO column_names FROM pg_attribute
    WHERE attrelid='public.player_game_stats'::regclass AND attnum>0 AND NOT attisdropped;
  SELECT array_agg(id) INTO all_games FROM public.nba_games;
  FOR part IN SELECT row.season_year,row.shard,row.child,row.existed,row.game_ids FROM jsonb_to_recordset(coalesce(plan,'[]')) row(season_year integer,shard integer,child text,existed boolean,game_ids uuid[]) LOOP
    IF part.existed THEN
      SELECT states||jsonb_build_object(part.child,coalesce(jsonb_object_agg(tgname,tgenabled),'{}')) INTO states
      FROM pg_trigger WHERE tgrelid=part.child::regclass AND NOT tgisinternal;
      EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER',part.child::regclass);
      EXECUTE format('WITH removed AS (DELETE FROM %s WHERE NOT (game_id=ANY($1)) RETURNING %s) SELECT coalesce(jsonb_agg(to_jsonb(removed)),''[]''::jsonb) FROM removed',part.child::regclass,column_names) INTO batch USING part.game_ids;
      moved:=moved||batch;
      EXECUTE format('ALTER TABLE public.player_game_stats DETACH PARTITION %s',part.child::regclass);
    ELSIF cardinality(part.game_ids)>0 THEN
      EXECUTE format('CREATE TABLE %s (LIKE public.player_game_stats INCLUDING ALL) WITH (fillfactor=90,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.05,autovacuum_vacuum_threshold=50,autovacuum_analyze_threshold=50)',part.child);
    END IF;
  END LOOP;
  SELECT states||jsonb_build_object('public.player_game_stats_default',coalesce(jsonb_object_agg(tgname,tgenabled),'{}')) INTO states
  FROM pg_trigger WHERE tgrelid='public.player_game_stats_default'::regclass AND NOT tgisinternal;
  ALTER TABLE public.player_game_stats_default DISABLE TRIGGER USER;
  EXECUTE format('WITH removed AS (DELETE FROM public.player_game_stats_default WHERE game_id=ANY($1) RETURNING %s) SELECT coalesce(jsonb_agg(to_jsonb(removed)),''[]''::jsonb) FROM removed',column_names) INTO batch USING all_games;
  moved:=moved||batch;
  FOR part IN SELECT row.season_year,row.shard,row.child,row.existed,row.game_ids FROM jsonb_to_recordset(coalesce(plan,'[]')) row(season_year integer,shard integer,child text,existed boolean,game_ids uuid[]) LOOP
    IF cardinality(part.game_ids)=0 THEN
      IF part.existed THEN
        DELETE FROM private.retention_status WHERE relation_name=part.child;
        DELETE FROM private.retention_rules WHERE relation_name=part.child;
        EXECUTE format('DROP TABLE %s',part.child::regclass);
        DELETE FROM private.player_stats_partitions WHERE season_year=part.season_year AND shard=part.shard;
      END IF;
      CONTINUE;
    END IF;
    SELECT string_agg(quote_literal(id::text),',' ORDER BY id) INTO values_sql FROM unnest(part.game_ids) id;
    EXECUTE format('ALTER TABLE public.player_game_stats ATTACH PARTITION %s FOR VALUES IN (%s)',part.child,values_sql);
    child:=part.child::regclass;
    IF NOT states ? part.child THEN
      SELECT states||jsonb_build_object(part.child,coalesce(jsonb_object_agg(tgname,tgenabled),'{}')) INTO states
      FROM pg_trigger WHERE tgrelid=child AND NOT tgisinternal;
    END IF;
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER',child);
    EXECUTE format('INSERT INTO %s(%s) SELECT %s FROM jsonb_populate_recordset(NULL::public.player_game_stats,$1) WHERE game_id=ANY($2)',child,column_names,column_names) USING moved,part.game_ids;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',child);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,anon,authenticated,service_role',child);
    EXECUTE format('GRANT SELECT ON %s TO service_role',child);
    INSERT INTO private.player_stats_partitions(season_year,shard,partition_table,game_ids) VALUES(part.season_year,part.shard,child,part.game_ids)
    ON CONFLICT(season_year,shard) DO UPDATE SET partition_table=EXCLUDED.partition_table,game_ids=EXCLUDED.game_ids;
    INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES(child::text,'NBA season partition of public.player_game_stats; durable scoring history') ON CONFLICT(relation_name) DO NOTHING;
    EXECUTE format('ANALYZE %s',child);
  END LOOP;
  EXECUTE format('INSERT INTO public.player_game_stats_default(%s) SELECT %s FROM jsonb_populate_recordset(NULL::public.player_game_stats,$1) WHERE NOT (game_id=ANY($2))',column_names,column_names) USING moved,all_games;
  FOR part IN SELECT key AS child,value AS triggers FROM jsonb_each(states) LOOP
    IF to_regclass(part.child) IS NULL THEN CONTINUE; END IF;
    FOR trigger_state IN SELECT key AS name,value AS enabled FROM jsonb_each_text(part.triggers) LOOP
      EXECUTE format('ALTER TABLE %s %s TRIGGER %I',part.child::regclass,
        CASE trigger_state.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END,trigger_state.name);
    END LOOP;
  END LOOP;
  SELECT partition_table INTO requested FROM private.player_stats_partitions WHERE season_year=p_year ORDER BY shard LIMIT 1;
  RETURN coalesce(requested,'public.player_game_stats_default'::regclass);
END;
$$;
CREATE OR REPLACE FUNCTION private.guard_player_stats_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' AS $$
DECLARE old_id uuid; old_game uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.game_id) IS NOT DISTINCT FROM ROW(OLD.id,OLD.game_id) THEN RETURN NEW; END IF;
    old_id:=OLD.id; old_game:=OLD.game_id;
  END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'Partition identity writes require READ COMMITTED' USING ERRCODE='0A000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pgs-id:'||NEW.id::text,0));
  IF EXISTS(SELECT FROM public.player_game_stats row WHERE row.id=NEW.id AND row.game_id<>NEW.game_id
    AND (old_id IS NULL OR ROW(row.id,row.game_id) IS DISTINCT FROM ROW(old_id,old_game))) THEN
    RAISE EXCEPTION 'Duplicate player stats identity across seasons' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.ensure_player_stats_partition(integer) OWNER TO postgres;
ALTER FUNCTION private.guard_player_stats_identity() OWNER TO postgres;
DO $$
DECLARE original regclass:='public.player_game_stats'; index_defs text[]; foreign_defs text[]; trigger_defs text[];
  view_defs jsonb; policy_defs text[]; grants jsonb; owner_name text; original_rls boolean; original_force boolean;
  definition text; privilege record; view_row record; season integer; column_names text;
  helper_identity regprocedure; helper_definition text; helper_owner text; helper_grants jsonb; trigger_states jsonb; trigger_state record;
BEGIN
  LOCK TABLE public.player_game_stats IN ACCESS EXCLUSIVE MODE;
  SELECT p.oid::regprocedure,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner)
  INTO helper_identity,helper_definition,helper_owner FROM pg_proc p WHERE p.oid='private.player_game_appeared(public.player_game_stats)'::regprocedure;
  SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO helper_grants
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=helper_identity;
  IF (SELECT relkind FROM pg_class WHERE oid=original)<>'r' THEN RAISE EXCEPTION 'Stats table is already partitioned'; END IF;
  SELECT pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity INTO owner_name,original_rls,original_force FROM pg_class WHERE oid=original;
  SELECT array_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) INTO index_defs FROM pg_index WHERE indrelid=original AND NOT indisunique;
  SELECT array_agg('ADD CONSTRAINT '||quote_ident(conname)||' '||pg_get_constraintdef(oid)) INTO foreign_defs FROM pg_constraint WHERE conrelid=original AND contype='f';
  SELECT array_agg(pg_get_triggerdef(oid) ORDER BY tgname) INTO trigger_defs FROM pg_trigger WHERE tgrelid=original AND NOT tgisinternal;
  SELECT jsonb_object_agg(tgname,tgenabled) INTO trigger_states FROM pg_trigger WHERE tgrelid=original AND NOT tgisinternal;
  IF cardinality(trigger_defs)<>24 THEN RAISE EXCEPTION 'Unexpected stats trigger count: %',cardinality(trigger_defs); END IF;
  SELECT jsonb_agg(jsonb_build_object('name',name,'definition',pg_get_viewdef(name::regclass,true),'options',(SELECT array_to_string(reloptions,',') FROM pg_class WHERE oid=name::regclass))) INTO view_defs
    FROM unnest(ARRAY['public.v_fantasy_points','analytics.mv_player_avg_fantasy_points']) name;
  SELECT array_agg(format('CREATE POLICY %I ON public.player_game_stats AS %s FOR %s TO %s%s%s',polname,
    CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
    CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
    (SELECT string_agg(CASE WHEN role_id=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(role_id)) END,',') FROM unnest(polroles) role_id),
    CASE WHEN polqual IS NULL THEN '' ELSE ' USING ('||pg_get_expr(polqual,polrelid)||')' END,
    CASE WHEN polwithcheck IS NULL THEN '' ELSE ' WITH CHECK ('||pg_get_expr(polwithcheck,polrelid)||')' END)) INTO policy_defs FROM pg_policy WHERE polrelid=original;
  SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO grants
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=original;
  ALTER TABLE public.player_game_stats RENAME TO player_game_stats_unpartitioned;
  CREATE TABLE public.player_game_stats (LIKE public.player_game_stats_unpartitioned INCLUDING ALL EXCLUDING INDEXES) PARTITION BY LIST(game_id);
  EXECUTE format('ALTER TABLE public.player_game_stats OWNER TO %I',owner_name);
  CREATE TABLE public.player_game_stats_default PARTITION OF public.player_game_stats DEFAULT WITH (fillfactor=90,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.05,autovacuum_vacuum_threshold=50,autovacuum_analyze_threshold=50);
  EXECUTE format('ALTER TABLE public.player_game_stats_default OWNER TO %I',owner_name);
  ALTER TABLE public.player_game_stats_default ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.player_game_stats_default FROM PUBLIC,anon,authenticated,service_role;
  GRANT SELECT ON public.player_game_stats_default TO service_role;
  FOR season IN SELECT DISTINCT season_year FROM public.player_game_stats_unpartitioned
    UNION SELECT year FROM generate_series(extract(year FROM now())::integer,extract(year FROM now())::integer+2) year LOOP
    PERFORM private.ensure_player_stats_partition(season);
  END LOOP;
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO column_names FROM pg_attribute WHERE attrelid='public.player_game_stats'::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('INSERT INTO public.player_game_stats(%s) SELECT %s FROM public.player_game_stats_unpartitioned',column_names,column_names);
  FOR view_row IN SELECT row.name,row.definition,row.options FROM jsonb_to_recordset(view_defs) AS row(name text,definition text,options text) ORDER BY row.name DESC LOOP
    EXECUTE format('CREATE OR REPLACE VIEW %s%s AS %s',view_row.name,CASE WHEN view_row.options IS NULL THEN '' ELSE ' WITH ('||view_row.options||')' END,view_row.definition);
  END LOOP;
  EXECUTE 'DROP FUNCTION '||helper_identity::text;
  DROP TABLE public.player_game_stats_unpartitioned;
  EXECUTE helper_definition;
  EXECUTE format('ALTER FUNCTION private.player_game_appeared(public.player_game_stats) OWNER TO %I',helper_owner);
  REVOKE ALL ON FUNCTION private.player_game_appeared(public.player_game_stats) FROM PUBLIC,anon,authenticated,service_role;
  FOR privilege IN SELECT row.role,row.privilege,row.grantable FROM jsonb_to_recordset(helper_grants) AS row(role text,privilege text,grantable boolean) LOOP
    EXECUTE format('GRANT %s ON FUNCTION private.player_game_appeared(public.player_game_stats) TO %s%s',privilege.privilege,CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  ALTER TABLE public.player_game_stats ADD CONSTRAINT player_game_stats_pkey PRIMARY KEY(id,game_id);
  ALTER TABLE public.player_game_stats ADD CONSTRAINT player_game_stats_player_id_game_id_key UNIQUE(player_id,game_id);
  FOREACH definition IN ARRAY coalesce(index_defs,'{}') LOOP EXECUTE definition; END LOOP;
  FOREACH definition IN ARRAY coalesce(foreign_defs,'{}') LOOP EXECUTE 'ALTER TABLE public.player_game_stats '||definition; END LOOP;
  FOREACH definition IN ARRAY coalesce(policy_defs,'{}') LOOP EXECUTE definition; END LOOP;
  FOREACH definition IN ARRAY trigger_defs LOOP EXECUTE definition; END LOOP;
  FOR trigger_state IN SELECT key AS name,value AS enabled FROM jsonb_each_text(trigger_states) LOOP
    EXECUTE format('ALTER TABLE public.player_game_stats %s TRIGGER %I',CASE trigger_state.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END,trigger_state.name);
  END LOOP;
  EXECUTE format('ALTER TABLE public.player_game_stats OWNER TO %I',owner_name);
  IF original_rls THEN ALTER TABLE public.player_game_stats ENABLE ROW LEVEL SECURITY; END IF;
  IF original_force THEN ALTER TABLE public.player_game_stats FORCE ROW LEVEL SECURITY; END IF;
  REVOKE ALL ON public.player_game_stats FROM PUBLIC,anon,authenticated,service_role;
  FOR privilege IN SELECT row.role,row.privilege,row.grantable FROM jsonb_to_recordset(grants) AS row(role text,privilege text,grantable boolean) LOOP
    EXECUTE format('GRANT %s ON public.player_game_stats TO %s%s',privilege.privilege,CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END;
$$;
CREATE TRIGGER zz_player_stats_identity BEFORE INSERT OR UPDATE ON public.player_game_stats FOR EACH ROW EXECUTE FUNCTION private.guard_player_stats_identity();
INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
  ('private.player_stats_partitions','Durable season partition catalog'),
  ('public.player_game_stats_default','Default season partition; durable scoring history')
ON CONFLICT(relation_name) DO NOTHING;
ALTER FUNCTION private.ensure_player_stats_partition(integer) OWNER TO postgres;
ALTER FUNCTION private.guard_player_stats_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.ensure_player_stats_partition(integer),private.guard_player_stats_identity() FROM PUBLIC,anon,authenticated,service_role;
ANALYZE public.player_game_stats;
RESET search_path;
CREATE OR REPLACE FUNCTION private.retain_player_game_stats(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE season integer:=extract(year FROM p_now AT TIME ZONE 'America/New_York')::integer
  +(extract(month FROM p_now AT TIME ZONE 'America/New_York')>=7)::integer;
BEGIN
  PERFORM private.ensure_player_stats_partition(season);
  ANALYZE public.player_game_stats;
  RETURN jsonb_build_object('public.player_game_stats',0);
END;
$$;
ALTER FUNCTION private.retain_player_game_stats(timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.retain_player_game_stats(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
UPDATE private.retention_rules SET worker='retain_player_game_stats',run_order=170,
  retention_rule='Durable scoring history; prepare current and next season partitions; no automatic data deletion'
WHERE relation_name='public.player_game_stats';
NOTIFY pgrst,'reload schema';
