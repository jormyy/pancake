\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE event_partition_fixture AS
SELECT member.id AS member_id,member.league_id,member.user_id,gen_random_uuid() AS invocation_key,
  gen_random_uuid()::text AS function_name
FROM public.league_members member ORDER BY member.id LIMIT 1;
DO $$
DECLARE fixture record; parent regclass; old_partition regclass; held_partition regclass;
  invocation_id bigint; expired_event bigint; current_event bigint; result jsonb;
BEGIN
  SELECT member_id,league_id,user_id,invocation_key,function_name INTO STRICT fixture FROM event_partition_fixture;
  FOREACH parent IN ARRAY ARRAY['public.edge_invocations'::regclass,'public.league_events'::regclass] LOOP
    IF (SELECT relkind FROM pg_class WHERE oid=parent)<>'p' THEN RAISE EXCEPTION 'Missing event partition parent'; END IF;
    IF EXISTS(SELECT FROM pg_inherits WHERE inhparent=parent AND (
      has_table_privilege('anon',inhrelid,'SELECT') OR has_table_privilege('authenticated',inhrelid,'SELECT')
      OR has_table_privilege('service_role',inhrelid,'INSERT'))) THEN
      RAISE EXCEPTION 'A partition grants direct application access';
    END IF;
  END LOOP;
  old_partition:=private.ensure_log_partition('public.edge_invocations','2001-01-01');
  held_partition:=private.ensure_log_partition('public.edge_invocations','2001-02-01');
  INSERT INTO public.edge_invocations(function_name,invocation_key,queued_at,reconciled_at,status_code,worker_status)
  VALUES(fixture.function_name,fixture.invocation_key,'2001-01-02','2001-01-02',200,'succeeded') RETURNING id INTO invocation_id;
  BEGIN
    INSERT INTO public.edge_invocations(id,function_name,queued_at) OVERRIDING SYSTEM VALUE
    VALUES(invocation_id,fixture.function_name,now());
    RAISE EXCEPTION 'Cross-month invocation ID is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.edge_invocations(function_name,invocation_key,queued_at)
    VALUES(fixture.function_name,fixture.invocation_key,now());
    RAISE EXCEPTION 'Cross-month invocation key is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,worker_status)
  VALUES(fixture.function_name,now(),now(),200,'succeeded'),
    (fixture.function_name||'-held','2001-02-02','2001-02-02',500,'failed');
  result:=private.retain_edge_invocations(now());
  IF EXISTS(SELECT FROM pg_class WHERE oid=old_partition)
    OR EXISTS(SELECT FROM public.edge_invocations WHERE id=invocation_id)
    OR NOT EXISTS(SELECT FROM pg_class WHERE oid=held_partition)
    OR NOT EXISTS(SELECT FROM public.edge_invocations WHERE function_name=fixture.function_name||'-held') THEN
    RAISE EXCEPTION 'Invocation retention loses newest outcomes or keeps an eligible partition: %',result;
  END IF;
  old_partition:=private.ensure_log_partition('public.league_events','2001-01-01');
  INSERT INTO public.league_events(league_id,member_id,kind,summary,created_at)
  VALUES(fixture.league_id,fixture.member_id,'partition.audit','expired','2001-01-02') RETURNING id INTO expired_event;
  BEGIN
    INSERT INTO public.league_events(id,league_id,member_id,kind,summary,created_at) OVERRIDING SYSTEM VALUE
    VALUES(expired_event,fixture.league_id,fixture.member_id,'partition.audit','duplicate',now());
    RAISE EXCEPTION 'Cross-month event ID is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.league_events(league_id,member_id,kind,summary)
  VALUES(fixture.league_id,fixture.member_id,'partition.audit','current') RETURNING id INTO current_event;
  result:=private.retain_league_events(now());
  IF EXISTS(SELECT FROM pg_class WHERE oid=old_partition)
    OR EXISTS(SELECT FROM public.league_events WHERE id=expired_event)
    OR NOT EXISTS(SELECT FROM public.league_events WHERE id=current_event) THEN
    RAISE EXCEPTION 'Event retention crosses its two-year boundary: %',result;
  END IF;
END;
$$;
SELECT set_config('request.jwt.claim.sub',user_id::text,true) FROM event_partition_fixture;
DO $$ BEGIN
  IF has_table_privilege('authenticated','public.league_events','SELECT') THEN
    RAISE EXCEPTION 'Partitioning adds direct member table access';
  END IF;
END; $$;
GRANT SELECT ON public.league_events TO authenticated;
GRANT SELECT ON event_partition_fixture TO authenticated;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT EXISTS(SELECT FROM public.league_events event JOIN event_partition_fixture fixture ON fixture.league_id=event.league_id
    WHERE event.kind='partition.audit' AND event.summary='current') THEN
    RAISE EXCEPTION 'Partitioning removes the member event policy';
  END IF;
END;
$$;
RESET ROLE;
ROLLBACK;
