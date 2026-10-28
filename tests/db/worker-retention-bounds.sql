BEGIN;
\ir rules-support.sql
DO $$
DECLARE body text; item record;
BEGIN
  FOR item IN SELECT proc.oid,proc.proname FROM pg_proc proc JOIN pg_namespace ns ON ns.oid=proc.pronamespace
    WHERE ns.nspname='private' AND proc.proname LIKE 'retain_%' LOOP
    body:=pg_get_functiondef(item.oid);
    PERFORM pg_temp.check_rules(body NOT LIKE '%LIMIT 10000%' AND body NOT LIKE '%LIMIT 20000%',item.proname||' caps each delete batch');
    PERFORM pg_temp.check_rules(body LIKE '%statement_timeout%3s%',item.proname||' declares a short statement budget');
  END LOOP;
END;
$$;
CREATE TEMP TABLE retention_fixture (id bigint PRIMARY KEY);
DO $$
DECLARE f record; before_count bigint; after_count bigint; removed bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9591);
  INSERT INTO public.perf_beacons(member_id,screen,useful_ms,request_count,transfer_bytes,bytes_complete,cold,device_class,connection_type,app_version,sample_n,received_at)
    SELECT f.member_ids[1],'matchup',10,1,0,true,false,'phone','unknown','test',1,now()-interval '31 days' FROM generate_series(1,12000);
  SELECT count(*) INTO before_count FROM public.perf_beacons WHERE received_at<now()-interval '30 days';
  removed:=private.prune_perf_beacons();
  SELECT count(*) INTO after_count FROM public.perf_beacons WHERE received_at<now()-interval '30 days';
  PERFORM pg_temp.check_rules(removed=5000 AND before_count-after_count=5000,'legacy beacon prune deletes one batch and leaves continuation work');
END;
$$;
SELECT pg_temp.check_rules(EXISTS(SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='service_role' AND s.setconfig @> ARRAY['statement_timeout=3s','lock_timeout=250ms']),'worker requests have database statement and lock budgets');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
