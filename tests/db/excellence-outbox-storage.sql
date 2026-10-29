\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
SET LOCAL statement_timeout='30s';
DO $$
DECLARE member uuid; identity uuid; key text:=gen_random_uuid()::text; payload jsonb; count_inserted integer;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid='public.notification_outbox'::regclass)<>'r' THEN RAISE EXCEPTION 'Notification outbox does not use native global keys'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.notification_outbox'::regclass AND NOT tgisinternal)<>2 THEN RAISE EXCEPTION 'Outbox contains unexpected row guards'; END IF;
  IF has_function_privilege('anon','public.enqueue_rookie_pick_notification(uuid,uuid,uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.enqueue_rookie_pick_notification(uuid,uuid,uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.enqueue_rookie_pick_notification(uuid,uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Enqueue RPC grants are incorrect'; END IF;
  SELECT id INTO STRICT member FROM public.league_members ORDER BY id LIMIT 1;
  payload:=jsonb_build_array(jsonb_build_object('dedupe_key',key,'member_id',member,'event_type','partition-fixture','title','same','body','same','data','{}'::jsonb,'category','draft'));
  count_inserted:=private.enqueue_notifications(payload||jsonb_set(payload,'{0,title}','"second"'::jsonb));
  IF count_inserted<>1 OR private.enqueue_notifications(payload)<>0 THEN RAISE EXCEPTION 'Batched notification dedupe is not idempotent'; END IF;
  SELECT id INTO STRICT identity FROM public.notification_outbox WHERE dedupe_key=key;
  IF (SELECT title FROM public.notification_outbox WHERE id=identity)<>'same' THEN RAISE EXCEPTION 'Batch dedupe changes first-writer content'; END IF;
  BEGIN
    INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,created_at)
    VALUES(key,member,'partition-fixture','same','same','{}','draft',now()-interval '1 year');
    RAISE EXCEPTION 'Cross-month dedupe key is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.notification_outbox(id,dedupe_key,member_id,event_type,title,body,data,category,created_at)
    VALUES(identity,key||'-other',member,'partition-fixture','same','same','{}','draft',now()-interval '1 year');
    RAISE EXCEPTION 'Cross-month outbox ID is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE public.notification_outbox SET created_at=now()-interval '1 month' WHERE id=identity;
  IF (SELECT count(*) FROM public.notification_outbox WHERE id=identity)<>1 THEN RAISE EXCEPTION 'Outbox movement changes its identity'; END IF;
  UPDATE public.notification_outbox SET expo_ticket_id='ticket:'||key,push_token='ExponentPushToken[partition]',ticketed_at=now() WHERE id=identity;
  BEGIN
    INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,created_at,expo_ticket_id,push_token,ticketed_at)
    VALUES(key||'-ticket',member,'partition-fixture','same','same','{}','draft',now(),'ticket:'||key,'ExponentPushToken[partition]',now());
    RAISE EXCEPTION 'Cross-month ticket identity is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM private.enqueue_notifications((SELECT jsonb_agg(payload->0) FROM generate_series(1,1001)));
    RAISE EXCEPTION 'Notification batches have no bound';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,created_at,delivered_at)
  VALUES(key||'-old',member,'partition-fixture','old','old','{}','draft','2001-01-02','2001-01-03');
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,created_at)
  VALUES(key||'-pending',member,'partition-fixture','pending','pending','{}','draft','2001-02-02');
  PERFORM private.retain_notification_outbox(now());
  IF EXISTS(SELECT FROM public.notification_outbox WHERE dedupe_key=key||'-old')
    OR NOT EXISTS(SELECT FROM public.notification_outbox WHERE dedupe_key=key||'-pending') THEN RAISE EXCEPTION 'Outbox retention removes pending work or keeps expired messages'; END IF;
  PERFORM public.enqueue_rookie_pick_notification(gen_random_uuid(),member,gen_random_uuid(),identity);
  IF NOT EXISTS(SELECT FROM public.notification_outbox WHERE dedupe_key='rookie-pick:'||identity::text||':'||member::text
    AND title='Rookie Draft Pick Made' AND body='A player has been added to your roster.' AND category='draft') THEN RAISE EXCEPTION 'Rookie enqueue changes notification content'; END IF;
END;
$$;
ROLLBACK;
