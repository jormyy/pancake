BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION private.publish_league_version(p_league_id uuid,p_topics text[],p_sources text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE stored public.league_versions%ROWTYPE; readers uuid[]; change_topic text; change_scope jsonb;
BEGIN
    PERFORM 1 FROM public.league_versions WHERE league_id=p_league_id FOR UPDATE;
    SELECT CASE WHEN league.deleted_at IS NULL
      THEN ARRAY(SELECT member.user_id FROM public.league_members member WHERE member.league_id=league.id ORDER BY member.user_id)
      ELSE ARRAY[]::uuid[] END INTO readers FROM public.leagues league WHERE league.id=p_league_id;
    IF NOT FOUND THEN RETURN; END IF;
    INSERT INTO public.league_versions AS current(league_id,version,reader_ids)
      VALUES(p_league_id,1,readers)
    ON CONFLICT(league_id) DO UPDATE SET version=current.version+1,updated_at=clock_timestamp(),reader_ids=EXCLUDED.reader_ids
    RETURNING league_id,version,updated_at,reader_ids INTO stored;
    change_topic := CASE WHEN cardinality(p_topics)=1 THEN p_topics[1] ELSE 'batch' END;
    change_scope := jsonb_build_object('topics',p_topics,'tables',p_sources);
    INSERT INTO public.league_changes(league_id,version,topic,scope,created_at)
      VALUES(stored.league_id,stored.version,change_topic,change_scope,stored.updated_at);
    DELETE FROM public.league_changes WHERE league_id=stored.league_id AND version<=stored.version-128;
    INSERT INTO public.league_change_hints AS hint(league_id,topic,revision,scopes,details,updated_at)
      VALUES(stored.league_id,'version',stored.version,NULL,jsonb_build_array(jsonb_build_object(
        'version',stored.version::text,'topic',change_topic,'scope',change_scope,'created_at',stored.updated_at)),stored.updated_at)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=EXCLUDED.revision,scopes=NULL,details=EXCLUDED.details,updated_at=EXCLUDED.updated_at;
END;
$$;
CREATE OR REPLACE FUNCTION private.flush_deferred_league_versions(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pending record; processed integer:=0;
BEGIN
  FOR pending IN SELECT transaction_id,league_id,topics,sources FROM private.league_version_pending
    WHERE transaction_id<>pg_current_xact_id()
    ORDER BY transaction_id,league_id LIMIT LEAST(GREATEST(COALESCE(p_limit,1000),0),5000)
    FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      PERFORM private.publish_league_version(pending.league_id,pending.topics,pending.sources);
      DELETE FROM private.league_version_pending
        WHERE transaction_id=pending.transaction_id AND league_id=pending.league_id;
      processed:=processed+1;
    EXCEPTION WHEN serialization_failure OR lock_not_available THEN
      NULL;
    END;
  END LOOP;
  RETURN processed;
END;
$$;
CREATE OR REPLACE FUNCTION private.league_version_flush()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pending record;
BEGIN
  FOR pending IN SELECT transaction_id,league_id,topics,sources FROM private.league_version_pending
    WHERE transaction_id=pg_current_xact_id() ORDER BY league_id LOOP
    BEGIN
      PERFORM private.publish_league_version(pending.league_id,pending.topics,pending.sources);
      DELETE FROM private.league_version_pending
        WHERE transaction_id=pending.transaction_id AND league_id=pending.league_id;
    EXCEPTION WHEN serialization_failure THEN
      IF NOT pending.sources <@ ARRAY['faab_balances']::text[] THEN RAISE; END IF;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION private.refresh_changed_screen_views()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='league_change_hints' AND row_data->>'topic'='inventory'
    AND EXISTS(SELECT 1 FROM private.league_version_pending
      WHERE transaction_id=pg_current_xact_id() AND league_id=(row_data->>'league_id')::uuid) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME<>'league_change_hints' AND current_setting('pancake.trade_write',true)='true' THEN
    PERFORM private.queue_trade_publication(
      CASE WHEN TG_TABLE_NAME='leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'league_change_hints' AND row_data->>'topic' = 'version'
    AND jsonb_array_length(COALESCE(row_data->'details'->0->'scope'->'tables', '[]')) > 0
    AND row_data->'details'->0->'scope'->'tables' <@ '["standings_current","matchup_totals","player_season_averages","trade_value_cache"]'::jsonb THEN
    RETURN NULL;
  END IF;
  PERFORM private.refresh_queue_screen_views(
    CASE WHEN TG_TABLE_NAME = 'leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION private.flush_league_inventory_hints(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit,1000),0),5000);
  v_league_id uuid;
  v_ids uuid[];
  v_details jsonb;
  v_processed integer := 0;
BEGIN
  FOR v_league_id IN
    SELECT DISTINCT pending.league_id FROM (
      SELECT league_id FROM private.league_hint_pending ORDER BY created_at,id LIMIT v_limit
    ) pending ORDER BY pending.league_id
  LOOP
    EXIT WHEN v_processed>=v_limit;
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtextextended('league-inventory-hint:'||v_league_id::text,0)) THEN
        CONTINUE;
      END IF;
      SELECT array_agg(pending.id) INTO v_ids FROM (
        SELECT id FROM private.league_hint_pending WHERE league_id=v_league_id
          ORDER BY created_at,id LIMIT v_limit-v_processed FOR UPDATE SKIP LOCKED
      ) pending;
      IF v_ids IS NULL THEN CONTINUE; END IF;
      IF EXISTS(SELECT 1 FROM public.leagues WHERE id=v_league_id AND deleted_at IS NULL) THEN
        v_details := NULL;
        IF cardinality(v_ids)=1 THEN
          SELECT details INTO v_details FROM private.league_hint_pending WHERE id=v_ids[1];
        END IF;
        PERFORM 1 FROM public.league_change_hints
          WHERE league_id=v_league_id AND topic='inventory' FOR UPDATE NOWAIT;
        INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
          VALUES(v_league_id,'inventory',cardinality(v_ids),NULL,v_details)
        ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+EXCLUDED.revision,
          scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp();
      END IF;
      DELETE FROM private.league_hint_pending WHERE id=ANY(v_ids);
      v_processed := v_processed+cardinality(v_ids);
    EXCEPTION WHEN serialization_failure OR lock_not_available THEN
      NULL;
    END;
  END LOOP;
  PERFORM private.flush_deferred_league_versions(v_limit);
  RETURN v_processed;
END;
$$;
CREATE OR REPLACE FUNCTION public.view_context(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE member public.league_members%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  today date; week integer; context_version bigint; dirty boolean;
BEGIN
  IF jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'View parameters must be an object.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO member FROM public.league_members WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'This screen is not available.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO league FROM public.leagues WHERE id = p_league_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'This screen is not available.' USING ERRCODE = '42501'; END IF;
  today := (now() AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date;
  SELECT * INTO season FROM public.league_seasons WHERE league_id = p_league_id
    AND (p_params->>'seasonId' IS NULL OR id = (p_params->>'seasonId')::uuid)
    ORDER BY is_current DESC, season_year DESC LIMIT 1;
  IF p_params->>'seasonId' IS NOT NULL AND season.id IS NULL THEN RAISE EXCEPTION 'This season is not available.' USING ERRCODE = '42501'; END IF;
  SELECT week_number INTO week FROM public.season_weeks WHERE season_year = season.season_year
    ORDER BY CASE WHEN today BETWEEN week_start AND week_end THEN 0 WHEN week_start > today THEN 1 ELSE 2 END,
      CASE WHEN week_start >= today THEN week_start END, week_end DESC LIMIT 1;
  SELECT q.version, q.dirty INTO context_version, dirty FROM private.screen_refresh_queue q WHERE q.league_season_id = season.id;
  dirty:=COALESCE(dirty,true) OR EXISTS(SELECT 1 FROM private.league_version_pending WHERE league_id=p_league_id);
  RETURN jsonb_build_object('leagueId', p_league_id, 'memberId', p_member_id, 'league', to_jsonb(league),
    'member', to_jsonb(member), 'season', CASE WHEN season.id IS NULL THEN NULL ELSE to_jsonb(season) END,
    'seasonId', season.id, 'seasonYear', COALESCE((p_params->>'seasonYear')::integer, season.season_year, public.current_season_year_et()),
    'weekNumber', COALESCE((p_params->>'weekNumber')::integer, week), 'today', today,
    'pendingIncomingCount', public.get_pending_trade_count(p_member_id, p_league_id),
    'version', context_version, 'stale', COALESCE(dirty, true))
    || CASE WHEN p_params ? 'tradeId' THEN jsonb_build_object('tradeAnalysisStale',
      CASE WHEN private.can_read_trade((p_params->>'tradeId')::uuid) THEN
        COALESCE((SELECT published.valid_until<=now() OR published.version IS DISTINCT FROM context_version
          FROM private.trade_value_publications published JOIN public.trades trade ON trade.id=published.trade_id
          WHERE trade.id=(p_params->>'tradeId')::uuid AND trade.league_id=p_league_id
            AND trade.league_season_id=season.id),true) OR COALESCE(dirty,true)
      ELSE true END) ELSE '{}'::jsonb END;
END;
$$;
ALTER FUNCTION private.publish_league_version(uuid,text[],text[]) OWNER TO postgres;
ALTER FUNCTION private.flush_deferred_league_versions(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.publish_league_version(uuid,text[],text[]),private.flush_deferred_league_versions(integer) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
