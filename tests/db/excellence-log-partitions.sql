\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
DO $$
DECLARE parent regclass; day date:=(now() AT TIME ZONE 'UTC')::date; key uuid:=gen_random_uuid(); shifted uuid:=gen_random_uuid();
  future_key uuid:=gen_random_uuid(); old_partition regclass; result jsonb; beacon_id bigint; member_key uuid;
BEGIN
  FOREACH parent IN ARRAY ARRAY['public.perf_beacons'::regclass,'private.request_receipts'::regclass] LOOP
    IF (SELECT relkind FROM pg_class WHERE oid=parent)<>'p' THEN RAISE EXCEPTION 'Log table is not partitioned: %',parent; END IF;
    PERFORM private.ensure_log_partition(parent,(day-interval '3 months')::date);
    IF EXISTS(SELECT FROM pg_inherits WHERE inhparent=parent AND (
      has_table_privilege('anon',inhrelid,'SELECT') OR has_table_privilege('authenticated',inhrelid,'SELECT')
      OR has_table_privilege('service_role',inhrelid,'INSERT'))) THEN
      RAISE EXCEPTION 'A child partition exposes a direct application grant';
    END IF;
  END LOOP;
  SELECT id INTO STRICT member_key FROM public.league_members ORDER BY id LIMIT 1;
  INSERT INTO public.perf_beacons(member_id,screen,useful_ms,request_count,transfer_bytes,bytes_complete,cold,device_class,connection_type,app_version,sample_n,received_at)
    VALUES(member_key,'roster',1,1,0,true,false,'phone','unknown','partition-test',1,day-interval '3 months') RETURNING id INTO beacon_id;
  BEGIN
    INSERT INTO public.perf_beacons(id,member_id,screen,useful_ms,request_count,transfer_bytes,bytes_complete,cold,device_class,connection_type,app_version,sample_n,received_at) OVERRIDING SYSTEM VALUE
      VALUES(beacon_id,member_key,'roster',1,1,0,true,false,'phone','unknown','partition-test',1,day);
    RAISE EXCEPTION 'Cross-month duplicate beacon identity is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE public.perf_beacons SET received_at=day WHERE id=beacon_id;
  IF (SELECT count(*) FROM public.perf_beacons WHERE id=beacon_id)<>1 THEN RAISE EXCEPTION 'Moving a beacon changes identity count'; END IF;
  INSERT INTO private.request_receipts VALUES(key,key,'partition-test','{}',day-interval '3 months','same');
  BEGIN
    INSERT INTO private.request_receipts VALUES(key,key,'partition-test','{}',day,'same');
    RAISE EXCEPTION 'Cross-month duplicate request identity is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO private.request_receipts VALUES(shifted,shifted,'partition-test','{}',day-interval '3 months','move');
  UPDATE private.request_receipts SET created_at=day WHERE request_id=shifted;
  IF (SELECT count(*) FROM private.request_receipts WHERE request_id=shifted)<>1 THEN
    RAISE EXCEPTION 'A moved receipt changes identity count';
  END IF;
  INSERT INTO private.request_receipts VALUES(future_key,future_key,'partition-test','{}',day+interval '6 months','future');
  PERFORM private.ensure_log_partition('private.request_receipts',(day+interval '6 months')::date);
  IF NOT EXISTS(SELECT FROM private.request_receipts WHERE request_id=future_key
    AND tableoid<>(SELECT inhrelid FROM pg_inherits WHERE inhparent='private.request_receipts'::regclass AND pg_get_expr((SELECT relpartbound FROM pg_class WHERE oid=inhrelid),inhrelid)='DEFAULT')) THEN
    RAISE EXCEPTION 'Future partition does not move default rows';
  END IF;
  SELECT partition_table INTO old_partition FROM private.log_partitions
    WHERE parent_table='private.request_receipts'::regclass AND lower_bound=date_trunc('month',day-interval '3 months')::date;
  result:=private.retain_request_receipts(day::timestamptz);
  IF EXISTS(SELECT FROM pg_class WHERE oid=old_partition) OR EXISTS(SELECT FROM private.request_receipts WHERE request_id=key)
    OR NOT EXISTS(SELECT FROM private.request_receipts WHERE request_id=shifted) THEN
    RAISE EXCEPTION 'Receipt retention does not drop only expired months: %',result;
  END IF;
END;
$$;
ROLLBACK;
