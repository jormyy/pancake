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
      EXECUTE format('CREATE TABLE %s (LIKE public.player_game_stats INCLUDING ALL) WITH (fillfactor=90,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02,autovacuum_vacuum_threshold=50,autovacuum_analyze_threshold=25)',part.child);
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
