BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; queued uuid; admitted uuid; token uuid:=gen_random_uuid(); before_count bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9526);
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
    VALUES(gen_random_uuid()::text,f.member_ids[1],'trade_expired','Expired','Expired','{}','trade') RETURNING id INTO queued;
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,claimed_at,claim_token)
    VALUES(gen_random_uuid()::text,f.member_ids[2],'trade_expired','Expired','Expired','{}','trade',now(),token) RETURNING id INTO admitted;
  UPDATE leagues SET deleted_at=now() WHERE id=f.league_id;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_notification_outbox_atomic(100,60) WHERE id=queued),
    'deleted league expiry never reaches delivery');
  PERFORM pg_temp.check_rules((SELECT suppression_reason='league_deleted' AND suppressed_at IS NOT NULL FROM notification_outbox WHERE id=queued),
    'claim suppresses deleted league with its own reason');
  PERFORM pg_temp.check_rules(NOT public.notif_admit_delivery_atomic(admitted,token),'deletion after claim refuses admission');
  PERFORM pg_temp.check_rules((SELECT suppression_reason='league_deleted' FROM notification_outbox WHERE id=admitted),
    'admission persists league deletion reason');
  SELECT count(*) INTO before_count FROM notification_outbox WHERE member_id=ANY(f.member_ids);
  PERFORM private.notif_enqueue('trade_expired',gen_random_uuid()::text,f.league_id,f.member_ids[1]);
  PERFORM pg_temp.check_rules((SELECT count(*)=before_count FROM notification_outbox WHERE member_id=ANY(f.member_ids)),
    'deleted league does not enqueue new notifications');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
