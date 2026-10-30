BEGIN;
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE l1_before_messages AS SELECT id FROM realtime.messages;
CREATE TEMP VIEW l1_broadcast_events AS SELECT message.id,message.topic,message.private,message.extension,message.event,
  CASE WHEN message.payload ? 'hints' THEN jsonb_build_object('schema','public','table','league_change_hints',
    'eventType',change.payload->>'event',
    'new',CASE WHEN change.payload->>'event'='DELETE' THEN '{}'::jsonb
      ELSE jsonb_build_object('league_id',split_part(message.topic,':',3))||(change.payload->'row') END,
    'old',CASE WHEN change.payload->>'event'='DELETE'
      THEN jsonb_build_object('league_id',split_part(message.topic,':',3))||(change.payload->'row') ELSE '{}'::jsonb END)
    ELSE change.payload END AS payload
  FROM realtime.messages message CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(message.payload->'hints')='array' THEN message.payload->'hints'
      ELSE jsonb_build_array(message.payload) END) change(payload);
DO $$
DECLARE source record; table_name text; identity uuid; row_count integer;
BEGIN
  SELECT member.league_id,member.id AS member_id,member.user_id,season.id AS season_id,gen_random_uuid() AS draft_id INTO STRICT source
    FROM public.league_members member JOIN public.league_seasons season ON season.league_id=member.league_id
    ORDER BY member.id,season.id LIMIT 1;
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,is_mock,created_by_member_id)
    VALUES(source.draft_id,source.league_id,source.season_id,'auction',true,source.member_id);
  FOREACH table_name IN ARRAY ARRAY['draft_budgets','draft_picks','drafts','league_change_hints','league_members','leagues',
    'matchup_forecasts','nominations','roster_players','snake_draft_picks','trade_block_items','trade_items',
    'trade_participants','trade_vetos','trades','waiver_claims'] LOOP
    EXECUTE format('CREATE TEMP TABLE %I(id uuid,league_id uuid,member_id uuid,user_id uuid,draft_id uuid,matchup_id uuid,topic text,revision bigint,updated_at timestamptz)',table_name);
    EXECUTE format('CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON pg_temp.%I FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change()',table_name);
    identity:=CASE table_name WHEN 'leagues' THEN source.league_id WHEN 'drafts' THEN source.draft_id ELSE gen_random_uuid() END;
    EXECUTE format('INSERT INTO pg_temp.%I VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())',table_name)
      USING identity,source.league_id,source.member_id,source.user_id,source.draft_id,identity,'score',1;
    EXECUTE format('UPDATE pg_temp.%I SET revision=2',table_name);
    EXECUTE format('DELETE FROM pg_temp.%I',table_name);
    SET CONSTRAINTS ALL IMMEDIATE;
    SELECT count(DISTINCT payload->>'eventType') INTO row_count FROM pg_temp.l1_broadcast_events messages
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp.l1_before_messages before WHERE before.id=messages.id) AND payload->>'table'=table_name
        AND payload->>'schema'='public' AND private AND extension='broadcast' AND event='change';
    IF row_count<>3 THEN RAISE EXCEPTION 'Missing INSERT/UPDATE/DELETE broadcast for %',table_name; END IF;
  END LOOP;
  identity:=gen_random_uuid();
  INSERT INTO pg_temp.league_change_hints(id,league_id,topic,revision,updated_at)
    VALUES(gen_random_uuid(),source.league_id,'score',1,clock_timestamp());
  UPDATE pg_temp.league_change_hints SET league_id=identity,revision=2;
  IF NOT EXISTS(SELECT 1 FROM pg_temp.l1_broadcast_events
    WHERE topic='l1:league:'||source.league_id::text AND payload->>'eventType'='UPDATE'
      AND payload->'new'->>'league_id'=identity::text) THEN
    RAISE EXCEPTION 'Moving a hint rewrites its source league'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_temp.l1_broadcast_events messages WHERE NOT EXISTS(SELECT 1 FROM pg_temp.l1_before_messages before WHERE before.id=messages.id) AND payload->>'table'='roster_players'
    AND payload->>'eventType'='DELETE' AND payload->'old'->>'member_id'=source.member_id::text) THEN
    RAISE EXCEPTION 'Roster DELETE loses the former owner'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_temp.l1_broadcast_events messages WHERE NOT EXISTS(SELECT 1 FROM pg_temp.l1_before_messages before WHERE before.id=messages.id) AND payload->>'table'='matchup_forecasts'
    AND payload->>'eventType'='UPDATE' AND payload->'new'->>'matchup_id'=payload->'old'->>'matchup_id') THEN
    RAISE EXCEPTION 'Forecast UPDATE loses its matchup'; END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.l1_broadcast_events messages WHERE NOT EXISTS(SELECT 1 FROM pg_temp.l1_before_messages before WHERE before.id=messages.id) AND payload->>'table'='waiver_claims'
    AND topic<>'l1:member:'||source.member_id::text) THEN RAISE EXCEPTION 'Claims leave the owner topic'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',source.user_id,'role','authenticated')::text,true);
  IF NOT private.can_receive_live_broadcast('l1:league:'||source.league_id::text)
    OR NOT private.can_receive_live_broadcast('l1:draft:'||source.draft_id::text)
    OR NOT private.can_receive_live_broadcast('l1:member:'||source.member_id::text)
    OR NOT private.can_receive_live_broadcast('l1:user:'||source.user_id::text) THEN
    RAISE EXCEPTION 'Owner cannot join the expected scopes'; END IF;
  IF private.can_receive_live_broadcast('l1:league:'||gen_random_uuid()::text)
    OR private.can_receive_live_broadcast('l1:user:'||gen_random_uuid()::text)
    OR private.can_receive_live_broadcast('l1:member:'||(SELECT id::text FROM public.league_members WHERE user_id<>source.user_id LIMIT 1))
    OR private.can_receive_live_broadcast('l1:league:invalid')
    OR private.can_receive_live_broadcast('l1:unknown:'||source.league_id::text)
    OR private.can_receive_live_broadcast('l1:league:'||source.league_id::text||':extra') THEN
    RAISE EXCEPTION 'A foreign or malformed scope is authorized'; END IF;
  PERFORM realtime.send('{"l1_policy":"probe"}'::jsonb,'change','l1:user:'||source.user_id::text,true);
  PERFORM realtime.send('{"l1_policy":"probe"}'::jsonb,'change','l1:user:'||gen_random_uuid()::text,true);
  PERFORM set_config('realtime.topic','l1:user:'||source.user_id::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF (SELECT count(*) FROM realtime.messages WHERE payload->>'l1_policy'='probe')<>1 THEN
    RAISE EXCEPTION 'An authenticated reader sees another topic'; END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('realtime.topic','legacy:probe',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF EXISTS(SELECT 1 FROM realtime.messages WHERE payload->>'l1_policy'='probe') THEN
    RAISE EXCEPTION 'A legacy topic bypasses broadcast authorization'; END IF;
  EXECUTE 'RESET ROLE';
END;
$$;
ROLLBACK;
