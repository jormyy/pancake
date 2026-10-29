BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE private.work_kinds ADD COLUMN retired_at timestamptz;
UPDATE private.work_kinds SET retired_at=clock_timestamp() WHERE kind='analyze-screen-table';
UPDATE private.work_items SET status='dead',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
  invocation_key=NULL,last_error='Retired: statistics refresh runs outside dispatch'
WHERE kind='analyze-screen-table' AND status IN ('pending','running','failed');
DROP TRIGGER IF EXISTS trade_rankings_analyze_insert ON public.dynasty_rankings;
DROP TRIGGER IF EXISTS trade_rankings_analyze_update ON public.dynasty_rankings;
DROP TRIGGER IF EXISTS trade_rankings_analyze_delete ON public.dynasty_rankings;
DROP FUNCTION private.analyze_trade_value_rankings();
DROP FUNCTION private.analyze_screen_table(text);

CREATE OR REPLACE FUNCTION private.work_enqueue(p_kind text, p_key text, p_due_at timestamptz DEFAULT now(), p_payload jsonb DEFAULT '{}'::jsonb, p_league_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id bigint;
BEGIN
  IF EXISTS(SELECT 1 FROM private.work_kinds WHERE kind=p_kind AND retired_at IS NOT NULL) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind=p_kind AND key=p_key) THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM private.work_items
    WHERE kind=p_kind AND status IN ('pending','running','failed')
      AND (CASE WHEN kind='pre-tipoff' THEN payload->>'tipoffAt' ELSE md5(payload::text) END)
        =(CASE WHEN p_kind='pre-tipoff' THEN p_payload->>'tipoffAt' ELSE md5(p_payload::text) END)
  ) THEN RETURN NULL; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
  VALUES(p_kind,p_key,p_due_at,p_payload,p_league_id)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_claim(p_limit integer DEFAULT 64)
RETURNS SETOF private.work_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  FOR v_item IN SELECT * FROM private.work_items WHERE status='running' AND lease_until<=now()
    ORDER BY lease_until,id LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE private.work_items SET lease_until=now()+interval '1 second' WHERE id=v_item.id;
    PERFORM private.work_finish(v_item.id,v_item.lease_token,'Worker lease expired');
  END LOOP;
  RETURN QUERY
    WITH due AS (SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
      AND NOT EXISTS(SELECT 1 FROM private.work_kinds kind WHERE kind.kind=private.work_items.kind AND kind.retired_at IS NOT NULL)
      ORDER BY due_at,id LIMIT greatest(0,least(p_limit,4-(SELECT count(*)::integer FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp()))) FOR UPDATE SKIP LOCKED)
    UPDATE private.work_items item SET status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
    FROM due WHERE item.id=due.id RETURNING item.*;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz;
  v_previous text:=coalesce(current_setting('pancake.work_id',true),'');
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE id=p_id AND lease_token=p_token AND status='running' AND lease_until>now();
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM private.work_kinds WHERE kind=v_item.kind AND retired_at IS NOT NULL) THEN
    UPDATE private.work_items SET status='dead',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
      invocation_key=NULL,last_error='Work kind is retired' WHERE id=p_id AND lease_token=p_token;
    RETURN;
  END IF;
  SELECT function_name INTO v_function FROM private.work_kinds WHERE kind=v_item.kind;
  v_payload:=v_item.payload;
  IF v_item.kind='league-inventory-hint-drain' AND (v_payload->>'delay')::int=0 THEN v_function:=NULL; END IF;
  IF v_item.kind='pre-tipoff' THEN
    v_tipoff:=(v_payload->>'tipoffAt')::timestamptz;
    IF v_tipoff<=now()-interval '1 minute' THEN RAISE EXCEPTION 'Tipoff window has closed'; END IF;
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date) VALUES(v_tipoff,(v_tipoff AT TIME ZONE 'America/New_York')::date) ON CONFLICT DO NOTHING;
    UPDATE public.lineup_tipoff_dispatches SET status='queued',token=p_token,attempts=attempts+1,
      lease_until=v_item.lease_until,error=NULL,input_revision=input_revision+(input_fingerprint IS DISTINCT FROM v_payload->>'fingerprint')::int,
      input_fingerprint=v_payload->>'fingerprint' WHERE tipoff_at=v_tipoff;
    v_payload:=(v_payload-'fingerprint')||jsonb_build_object('token',p_token);
  END IF;
  IF v_function IS NOT NULL THEN
    PERFORM set_config('pancake.work_id',p_id::text,true);
    PERFORM public.invoke_edge_function(v_function,v_payload);
    PERFORM set_config('pancake.work_id',v_previous,true);
    RETURN;
  END IF;
  CASE v_item.kind
    WHEN 'trade-publication' THEN PERFORM private.publish_trade_changes((v_payload->>'publicationId')::uuid);
    WHEN 'setup-season-rollover' THEN PERFORM private.roll_setup_league_seasons(now());
    WHEN 'daily-stat-corrections' THEN PERFORM public.queue_daily_stat_corrections();
    WHEN 'missing-final-stats' THEN PERFORM private.reconcile_missing_final_stats(now(),(v_payload->>'beforeDate')::date);
    WHEN 'edge-invocation-reconcile' THEN PERFORM private.reconcile_edge_invocations();
    WHEN 'player-stats-hints' THEN PERFORM private.flush_player_stats_hints();
    WHEN 'league-inventory-hint-drain' THEN PERFORM private.flush_league_inventory_hints(1000);
    WHEN 'cleanup-trade-estimates' THEN PERFORM public.cleanup_trade_estimate_quotes();
    WHEN 'mock-room-expiry' THEN PERFORM public.expire_mock_draft_rooms();
    WHEN 'public-read-retention' THEN PERFORM public.public_prune_read_log();
    WHEN 'retention-prune' THEN PERFORM private.run_retention();
    ELSE RAISE EXCEPTION 'Unknown SQL work kind: %',v_item.kind;
  END CASE;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;

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

CREATE OR REPLACE FUNCTION private.retain_player_game_stats(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE season integer:=extract(year FROM p_now AT TIME ZONE 'America/New_York')::integer
  +(extract(month FROM p_now AT TIME ZONE 'America/New_York')>=7)::integer;
BEGIN
  PERFORM private.ensure_player_stats_partition(season);
  RETURN jsonb_build_object('public.player_game_stats',0);
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_screen_statistics()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target regclass; started timestamptz; results jsonb:='[]'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.refresh_screen_statistics',0)) THEN
    RETURN jsonb_build_object('busy',true);
  END IF;
  FOREACH target IN ARRAY private.screen_statistics_targets() LOOP
    started:=clock_timestamp();
    BEGIN
      EXECUTE format('ANALYZE %s',target);
      results:=results||jsonb_build_object('relation',target::text,'status','analyzed',
        'milliseconds',round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,3));
    EXCEPTION WHEN lock_not_available THEN
      results:=results||jsonb_build_object('relation',target::text,'status','skipped',
        'milliseconds',round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,3),'sqlstate',SQLSTATE);
    END;
  END LOOP;
  RETURN results;
END;
$$;

ALTER FUNCTION private.refresh_screen_statistics() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.refresh_screen_statistics() FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('screen-statistics','15 10 * * *',$job$SET statement_timeout='10min'; SET lock_timeout='2s'; SET maintenance_work_mem='16MB'; SELECT private.refresh_screen_statistics();$job$);
COMMIT;
