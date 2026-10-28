BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE notification_scan_counter(calls integer NOT NULL);
INSERT INTO notification_scan_counter VALUES(0);
ALTER FUNCTION private.notif_is_stale(text,jsonb) RENAME TO bounded_saved_notif_is_stale;
CREATE FUNCTION private.notif_is_stale(p_event text,p_data jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE pg_temp.notification_scan_counter SET calls=calls+1;
  RETURN true;
END;
$$;
DO $$
DECLARE f record; scanned integer; suppressed integer; returned integer;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9590);
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,available_at)
  SELECT 'bounded-notification:'||f.league_id||':'||n,f.member_ids[1],'trade_completed','Bounded fixture','Fixture','{}','trade','1900-01-01' FROM generate_series(1,500) n;
  SELECT count(*) INTO returned FROM public.claim_notification_outbox_atomic(10,60);
  SELECT calls INTO scanned FROM notification_scan_counter;
  SELECT count(*) INTO suppressed FROM notification_outbox WHERE dedupe_key LIKE 'bounded-notification:'||f.league_id||':%' AND suppressed_at IS NOT NULL;
  PERFORM pg_temp.check_rules(scanned<=100 AND scanned>0,'expensive stale checks run only after the bounded candidate limit');
  PERFORM pg_temp.check_rules(suppressed=100 AND returned=0,'one claim clears one bounded stale batch without delivering it');
  UPDATE notification_scan_counter SET calls=0;
  PERFORM public.claim_notification_outbox_atomic(10,60);
  SELECT calls INTO scanned FROM notification_scan_counter;
  PERFORM pg_temp.check_rules(scanned<=100,'another claim has the same bounded cost');
  PERFORM pg_temp.check_rules((SELECT count(*)=200 FROM notification_outbox WHERE dedupe_key LIKE 'bounded-notification:'||f.league_id||':%' AND suppressed_at IS NOT NULL),'repeated claims make progress through the backlog');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
