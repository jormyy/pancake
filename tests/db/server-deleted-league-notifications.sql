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
DO $$
DECLARE f record; ticketed uuid; suppressed uuid; lease uuid; before_count bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9533);
  PERFORM set_config('app.supabase_url','http://127.0.0.1:1',true);
  PERFORM set_config('app.edge_internal_token','local-deleted-ticket-test',true);
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,expo_ticket_id,push_token,ticketed_at)
    VALUES(gen_random_uuid()::text,f.member_ids[1],'trade_expired','Expired','Expired','{}','trade','deleted-ticket','token',now()) RETURNING id INTO ticketed;
  UPDATE leagues SET deleted_at=now() WHERE id=f.league_id;
  PERFORM public.claim_notification_outbox_atomic(p_limit=>100,p_lease_seconds=>60);
  PERFORM pg_temp.check_rules((SELECT suppressed_at IS NULL FROM notification_outbox WHERE id=ticketed),
    'deleted league keeps accepted Expo ticket available for its receipt');
  SELECT claim_token INTO lease FROM public.claim_notification_receipts_atomic(p_limit=>200,p_lease_seconds=>60) WHERE id=ticketed;
  PERFORM pg_temp.check_rules(lease IS NOT NULL,'deleted league Expo receipt remains claimable');
  PERFORM public.complete_notification_outbox_atomic(ticketed,lease);
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,expo_ticket_id,push_token,ticketed_at,suppressed_at,suppression_reason)
    VALUES(gen_random_uuid()::text,f.member_ids[2],'trade_expired','Expired','Expired','{}','trade','suppressed-ticket','token',now(),now(),'league_deleted') RETURNING id INTO suppressed;
  SELECT count(*) INTO before_count FROM edge_invocations WHERE function_name='process-trades';
  PERFORM public.invoke_process_trades_if_due();
  PERFORM pg_temp.check_rules((SELECT count(*)=before_count FROM edge_invocations WHERE function_name='process-trades'),
    'suppressed Expo ticket does not wake the trade worker');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
