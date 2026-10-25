BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; ids uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; result jsonb; predicate text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9543);
  INSERT INTO notification_outbox(id,member_id,title,body,data,category,event_type,dedupe_key,created_at,available_at,delivered_at,dead_lettered_at,suppressed_at)
    SELECT id,f.member_ids[1],'Old','Body','{}','trade','trade_completed',id::text,now()-interval '80 days',now()-interval '80 days',
      CASE WHEN ordinal IN (1,5) THEN now()-CASE WHEN ordinal=1 THEN interval '70 days' ELSE interval '1 day' END END,
      CASE WHEN ordinal=2 THEN now()-interval '70 days' END,CASE WHEN ordinal=3 THEN now()-interval '70 days' END
    FROM unnest(ids) WITH ORDINALITY p(id,ordinal);
  INSERT INTO notification_outbox(dedupe_key,member_id,title,body,data,category,event_type,created_at,available_at,delivered_at)
    SELECT gen_random_uuid()::text,f.member_ids[1],'Batched','Body','{}','trade','trade_completed',now()-interval '80 days',now()-interval '80 days',now()-interval '70 days' FROM generate_series(1,501);
  result:=public.prune_unbounded_history();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_outbox WHERE id=ANY(ids[1:3])),'old terminal outbox rows are pruned');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM notification_outbox WHERE id=ANY(ids)),'pending and recently terminal outbox rows survive');
  PERFORM pg_temp.check_rules((result->>'notification_outbox')::int>=504,'prune reports outbox removals');
  SELECT pg_get_expr(indpred,indrelid) INTO predicate FROM pg_index WHERE indexrelid='public.notification_outbox_delivery_queue'::regclass;
  PERFORM pg_temp.check_rules(predicate ILIKE '%suppressed_at IS NULL%' AND predicate NOT ILIKE '%expo_ticket_id%','delivery index survives Expo column retirement');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
