CREATE OR REPLACE FUNCTION private.league_version_capture()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed_sql text; leagues_sql text; affected record;
  ignored text[] := ARRAY['updated_at','set_at'];
  home_changes jsonb; home_changed boolean; forecast_ids jsonb;
BEGIN
  IF TG_TABLE_NAME IN ('standings_current','matchup_totals','player_season_averages','trade_value_cache') THEN
    ignored := ignored||ARRAY['version','refreshed_at'];
  END IF;
  IF TG_TABLE_NAME='matchup_forecasts' THEN ignored:=ignored||ARRAY['calculated_at','valid_until','input_revision']; END IF;
  IF TG_TABLE_NAME='profiles' THEN ignored := ignored||ARRAY['push_token','push_token_revocation_hash']; END IF;
  IF TG_TABLE_NAME='nba_games' THEN
    ignored := ignored||ARRAY['live_stats_elapsed_seconds','live_scoreboard_elapsed_seconds','stats_synced_at'];
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM version_new_rows) THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM version_old_rows) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS(
      (SELECT to_jsonb(n)-ignored FROM version_new_rows n EXCEPT SELECT to_jsonb(o)-ignored FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-ignored FROM version_old_rows o EXCEPT SELECT to_jsonb(n)-ignored FROM version_new_rows n)) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='matchup_forecasts' THEN
    IF TG_OP='INSERT' THEN SELECT COALESCE(jsonb_agg(matchup_id),'[]') INTO forecast_ids FROM version_new_rows;
    ELSIF TG_OP='DELETE' THEN SELECT COALESCE(jsonb_agg(matchup_id),'[]') INTO forecast_ids FROM version_old_rows;
    ELSE SELECT COALESCE(jsonb_agg(matchup_id),'[]') INTO forecast_ids FROM (
      SELECT matchup_id FROM version_new_rows UNION SELECT matchup_id FROM version_old_rows) changed;
    END IF;
    SELECT COALESCE(jsonb_agg(DISTINCT value),'[]') INTO forecast_ids
      FROM jsonb_array_elements(COALESCE(NULLIF(current_setting('pancake.forecast_changes',true),'')::jsonb,'[]')||forecast_ids);
    PERFORM set_config('pancake.forecast_changes',forecast_ids::text,true);
  END IF;
  IF TG_TABLE_NAME='standings_current' THEN
    IF TG_OP='INSERT' THEN
      SELECT EXISTS(SELECT 1 FROM version_new_rows WHERE COALESCE(wins,0)<>0 OR COALESCE(losses,0)<>0) INTO home_changed;
    ELSIF TG_OP='DELETE' THEN
      SELECT EXISTS(SELECT 1 FROM version_old_rows WHERE COALESCE(wins,0)<>0 OR COALESCE(losses,0)<>0) INTO home_changed;
    ELSE
      SELECT EXISTS(
        (SELECT jsonb_build_array(n.member_id,n.league_season_id,n.wins,n.losses) FROM version_new_rows n
          EXCEPT SELECT jsonb_build_array(o.member_id,o.league_season_id,o.wins,o.losses) FROM version_old_rows o)
        UNION ALL
        (SELECT jsonb_build_array(o.member_id,o.league_season_id,o.wins,o.losses) FROM version_old_rows o
          EXCEPT SELECT jsonb_build_array(n.member_id,n.league_season_id,n.wins,n.losses) FROM version_new_rows n)
      ) INTO home_changed;
    END IF;
    home_changes:=COALESCE(NULLIF(current_setting('pancake.home_changes',true),'')::jsonb,'{}'::jsonb);
    PERFORM set_config('pancake.home_changes',jsonb_set(home_changes,ARRAY[TG_TABLE_NAME],
      to_jsonb(COALESCE((home_changes->>TG_TABLE_NAME)::boolean,false) OR home_changed))::text,true);
  END IF;
  IF TG_OP='INSERT' THEN changed_sql := 'SELECT to_jsonb(n) AS data FROM version_new_rows n';
  ELSIF TG_OP='DELETE' THEN changed_sql := 'SELECT to_jsonb(o) AS data FROM version_old_rows o';
  ELSE
    changed_sql := format($rows$
      (SELECT to_jsonb(n)-%L::text[] AS data FROM version_new_rows n
       EXCEPT SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o
       EXCEPT SELECT to_jsonb(n)-%L::text[] FROM version_new_rows n)
    $rows$,ignored,ignored,ignored,ignored);
  END IF;
  CASE TG_ARGV[1]
    WHEN 'league' THEN leagues_sql := 'SELECT (data->>''league_id'')::uuid AS league_id FROM changed';
    WHEN 'user' THEN leagues_sql := 'SELECT member.league_id FROM changed JOIN public.league_members member ON member.user_id=COALESCE((data->>''user_id'')::uuid,(data->>''id'')::uuid)';
    WHEN 'self' THEN leagues_sql := 'SELECT (data->>''id'')::uuid AS league_id FROM changed';
    WHEN 'draft' THEN leagues_sql := 'SELECT draft.league_id FROM changed JOIN public.drafts draft ON draft.id=(data->>''draft_id'')::uuid';
    WHEN 'trade' THEN leagues_sql := 'SELECT trade.league_id FROM changed JOIN public.trades trade ON trade.id=(data->>''trade_id'')::uuid';
    WHEN 'season' THEN leagues_sql := 'SELECT season.league_id FROM changed JOIN public.league_seasons season ON season.season_year=(data->>''season_year'')::integer';
    WHEN 'global' THEN leagues_sql := 'SELECT league.id AS league_id FROM public.leagues league WHERE league.deleted_at IS NULL AND EXISTS(SELECT 1 FROM changed)';
    ELSE RAISE EXCEPTION 'Unsupported league version source: %',TG_TABLE_NAME;
  END CASE;
  FOR affected IN EXECUTE format('WITH changed AS (%s) SELECT DISTINCT league_id FROM (%s) affected WHERE league_id IS NOT NULL ORDER BY league_id',changed_sql,leagues_sql) LOOP
    PERFORM private.league_version_enqueue(affected.league_id,TG_ARGV[0],TG_TABLE_NAME);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.broadcast_live_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_row jsonb:='{}'; previous_row jsonb:='{}'; payload jsonb; target text; targets text[]:=ARRAY[]::text[];
  row_data jsonb; league_id uuid; draft_id uuid; new_data jsonb:='{}'; old_data jsonb:='{}'; headers jsonb;
BEGIN
  IF TG_OP<>'DELETE' THEN current_row:=to_jsonb(NEW); END IF;
  IF TG_OP<>'INSERT' THEN previous_row:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='matchup_forecasts' AND TG_OP='UPDATE'
    AND current_row->'forecast' IS NOT DISTINCT FROM previous_row->'forecast'
    AND current_row->'matchup_id' IS NOT DISTINCT FROM previous_row->'matchup_id'
    AND current_row->'league_id' IS NOT DISTINCT FROM previous_row->'league_id' THEN RETURN NULL; END IF;
  headers:=COALESCE(NULLIF(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
  IF TG_TABLE_NAME='league_change_hints' AND auth.role()='service_role'
    AND headers->>'x-pancake-public-checkpoint'='true'
    AND current_setting('pancake.official_broadcast',true) IS DISTINCT FROM 'true'
    AND EXISTS(SELECT 1 FROM public.live_poll_leases WHERE lock_key=779001
      AND holder_id::text=headers->>'x-pancake-live-holder' AND expires_at>clock_timestamp())
    AND (current_row->>'topic' IN ('score','stat','game','player_stats') OR current_row->>'topic'='version'
      AND jsonb_array_length(COALESCE(current_row->'details'->0->'scope'->'tables','[]'::jsonb))>0
      AND current_row->'details'->0->'scope'->'tables' <@ '["matchups","matchup_totals","nba_games","player_game_stats"]'::jsonb) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='league_change_hints' THEN
    new_data:=current_row;
    IF TG_OP='DELETE' THEN old_data:=previous_row; END IF;
  ELSIF TG_TABLE_NAME='roster_players' THEN
    new_data:=jsonb_strip_nulls(jsonb_build_object('member_id',current_row->'member_id'));
    old_data:=jsonb_strip_nulls(jsonb_build_object('member_id',previous_row->'member_id'));
  ELSIF TG_TABLE_NAME='matchup_forecasts' THEN
    new_data:=jsonb_strip_nulls(jsonb_build_object('matchup_id',current_row->'matchup_id'));
    old_data:=jsonb_strip_nulls(jsonb_build_object('matchup_id',previous_row->'matchup_id'));
  END IF;
  payload:=jsonb_build_object('schema','public','table',TG_TABLE_NAME,'eventType',TG_OP,
    'commit_timestamp',clock_timestamp(),'new',new_data,'old',old_data,'errors','[]'::jsonb);
  FOREACH row_data IN ARRAY ARRAY[current_row,previous_row] LOOP
    IF row_data='{}'::jsonb THEN CONTINUE; END IF;
    IF TG_TABLE_NAME='waiver_claims' THEN
      targets:=array_append(targets,'l1:member:'||(row_data->>'member_id'));
      CONTINUE;
    END IF;
    league_id:=NULL; draft_id:=NULL;
    IF TG_TABLE_NAME='leagues' THEN league_id:=(row_data->>'id')::uuid;
    ELSE league_id:=(row_data->>'league_id')::uuid; END IF;
    IF TG_TABLE_NAME='drafts' THEN draft_id:=(row_data->>'id')::uuid;
    ELSIF TG_TABLE_NAME IN ('draft_budgets','nominations','snake_draft_picks') THEN draft_id:=(row_data->>'draft_id')::uuid; END IF;
    IF draft_id IS NOT NULL THEN
      targets:=array_append(targets,'l1:draft:'||draft_id::text);
      IF league_id IS NULL THEN SELECT draft.league_id INTO league_id FROM public.drafts draft WHERE draft.id=draft_id; END IF;
    END IF;
    IF league_id IS NOT NULL THEN targets:=array_append(targets,'l1:league:'||league_id::text); END IF;
    IF TG_TABLE_NAME='league_members' THEN targets:=array_append(targets,'l1:user:'||(row_data->>'user_id')); END IF;
  END LOOP;
  FOR target IN SELECT DISTINCT value FROM unnest(targets) value WHERE value IS NOT NULL ORDER BY value LOOP
    IF TG_TABLE_NAME='league_change_hints' THEN
      row_data:=CASE WHEN TG_OP='DELETE' THEN previous_row ELSE current_row END;
      IF target='l1:league:'||(row_data->>'league_id') THEN row_data:=row_data-'league_id'; END IF;
      INSERT INTO private.live_hint_broadcasts AS pending(transaction_id,topic,changes)
        VALUES(pg_current_xact_id(),target,jsonb_build_array(jsonb_build_object('event',TG_OP,
          'row',row_data)))
      ON CONFLICT(transaction_id,topic) DO UPDATE SET changes=pending.changes||EXCLUDED.changes;
    ELSIF target LIKE 'l1:league:%' AND TG_TABLE_NAME NOT IN ('leagues','league_members') THEN
      INSERT INTO private.live_hint_broadcasts AS pending(transaction_id,topic,changes)
        VALUES(pg_current_xact_id(),target,jsonb_build_array(jsonb_build_object('payload',payload)))
      ON CONFLICT(transaction_id,topic) DO UPDATE SET changes=pending.changes||EXCLUDED.changes;
    ELSE
      PERFORM realtime.send(payload,'change',target,true);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.publish_league_version(p_league_id uuid,p_topics text[],p_sources text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE stored public.league_versions%ROWTYPE; readers uuid[]; change_topic text; change_scope jsonb; forecast_ids jsonb;
BEGIN
    IF auth.role()='service_role'
      AND COALESCE(NULLIF(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb)->>'x-pancake-public-checkpoint'='true'
      AND current_setting('pancake.official_broadcast',true) IS DISTINCT FROM 'true'
      AND cardinality(p_sources)>0 AND p_sources<@ARRAY['matchups','matchup_totals','nba_games','player_game_stats']::text[]
      AND EXISTS(SELECT 1 FROM public.live_poll_leases WHERE lock_key=779001
        AND holder_id::text=COALESCE(NULLIF(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb)->>'x-pancake-live-holder'
        AND expires_at>clock_timestamp()) THEN RETURN; END IF;
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
    IF 'matchup_forecasts'=ANY(p_sources) THEN
      SELECT COALESCE(jsonb_agg(DISTINCT requested.value ORDER BY requested.value),'[]') INTO forecast_ids
      FROM jsonb_array_elements_text(COALESCE(NULLIF(current_setting('pancake.forecast_changes',true),'')::jsonb,'[]')) requested(value)
      JOIN public.matchups matchup ON matchup.id=requested.value::uuid AND matchup.league_id=p_league_id;
      IF jsonb_array_length(forecast_ids) BETWEEN 1 AND 32 THEN
        change_scope:=change_scope||jsonb_build_object('forecastMatchupIds',forecast_ids);
      END IF;
    END IF;
    IF cardinality(p_sources)>0 AND p_sources<@ARRAY['standings_current','matchup_totals','player_season_averages']::text[]
      AND (NOT 'standings_current'=ANY(p_sources)
        OR COALESCE(NULLIF(current_setting('pancake.home_changes',true),'')::jsonb->>'standings_current','true')='false') THEN
      change_scope:=change_scope||jsonb_build_object('homeChanged',false);
    END IF;
    change_scope := change_scope || jsonb_build_object('hints',COALESCE((
      SELECT CASE WHEN count(*)<=32 THEN jsonb_agg(item ORDER BY item::text) ELSE '[]'::jsonb END FROM (
        SELECT DISTINCT jsonb_build_object('topic',hint->'row'->'topic','scopes',hint->'row'->'scopes',
          'details',hint->'row'->'details') AS item
        FROM private.live_hint_broadcasts pending CROSS JOIN LATERAL jsonb_array_elements(pending.changes) hint
        WHERE pending.transaction_id=pg_current_xact_id() AND pending.topic='l1:league:'||p_league_id::text
          AND hint->'row'->>'topic'<>'version') scoped),'[]'::jsonb));
    INSERT INTO public.league_changes(league_id,version,topic,scope,created_at)
      VALUES(stored.league_id,stored.version,change_topic,change_scope,stored.updated_at);
    DELETE FROM public.league_changes WHERE league_id=stored.league_id AND version<=stored.version-128;
    INSERT INTO public.league_change_hints AS hint(league_id,topic,revision,scopes,details,updated_at)
      VALUES(stored.league_id,'version',stored.version,NULL,jsonb_build_array(jsonb_build_object(
        'version',stored.version::text,'topic',change_topic,'scope',change_scope,'created_at',stored.updated_at)),stored.updated_at)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=EXCLUDED.revision,scopes=NULL,details=EXCLUDED.details,updated_at=EXCLUDED.updated_at;
END;
$$;
