BEGIN;
UPDATE public.leagues SET deleted_at=now() WHERE deleted_at IS NULL;
UPDATE public.trades SET expires_at=now()+interval '1 day',veto_window_expires_at=now()+interval '1 day';
DELETE FROM public.notification_outbox;
DELETE FROM private.work_items WHERE kind='process-trades';
\ir rules-support.sql
SELECT set_config('app.supabase_url','http://127.0.0.1:1',true);
SELECT set_config('app.edge_internal_token','release-push-test',true);
UPDATE public.trades SET expires_at=now()+interval '1 day',veto_window_expires_at=now()+interval '1 day';
UPDATE public.notification_outbox SET available_at=now()+interval '1 day';
CREATE TEMP TABLE push_compat_fixture(user_id uuid,member_id uuid,notice_id uuid,lease uuid);
DO $$
DECLARE
  fixture record;
  notice uuid;
  lease uuid := gen_random_uuid();
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9531);
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category,
    expo_ticket_id,push_token,ticketed_at,available_at,claimed_at,claim_token)
  VALUES('review:legacy-receipt:'||fixture.member_ids[1],fixture.member_ids[1],'trade_completed','Trade','Completed','trade',
    'legacy-ticket-'||fixture.member_ids[1],'legacy-token-'||fixture.member_ids[1],now(),now(),now(),lease)
  RETURNING id INTO notice;
  INSERT INTO pg_temp.push_compat_fixture VALUES(fixture.user_ids[1],fixture.member_ids[1],notice,lease);
END;
$$;
\ir ../../supabase/migrations/20261026000080_retire_expo_push_storage.sql
DO $$
DECLARE
  fixture record;
  row record;
  v_notice_id uuid;
  token text;
  invocations bigint;
BEGIN
  SELECT * INTO fixture FROM pg_temp.push_compat_fixture;

  PERFORM pg_temp.check_rules(NOT has_column_privilege('authenticated','public.profiles','push_token','UPDATE'),
    'clients cannot update legacy tokens');
  PERFORM pg_temp.check_rules((SELECT expo_ticket_id='legacy-ticket-'||fixture.member_id AND claim_token=fixture.lease
    AND claimed_at IS NOT NULL AND ticketed_at IS NOT NULL FROM public.notification_outbox WHERE notification_outbox.id=fixture.notice_id),
    'the database phase preserves in-flight Expo tickets and leases');
  UPDATE public.notification_outbox SET claimed_at=NULL,claim_token=NULL WHERE notification_outbox.id=fixture.notice_id;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_notification_outbox_atomic(200) claimed
    WHERE claimed.id=fixture.notice_id), 'web delivery does not reclaim an Expo ticket');
  DELETE FROM private.work_items WHERE kind='process-trades';
  SELECT count(*) INTO invocations FROM private.work_items WHERE kind='process-trades';
  PERFORM private.enqueue_process_trades(now());
  PERFORM pg_temp.check_rules((SELECT count(*)=invocations+1 FROM private.work_items WHERE kind='process-trades'),
    'pending receipts enqueue receipt work');
  SELECT * INTO STRICT row FROM public.claim_notification_receipts_atomic(200) claimed WHERE claimed.id=fixture.notice_id;
  PERFORM pg_temp.check_rules(public.defer_notification_receipt_state_atomic(row.id,row.claim_token,'provider pending',60,true)='deferred',
    'the deployed Edge can defer pending receipts');
  UPDATE public.notification_outbox SET available_at=now() WHERE notification_outbox.id=fixture.notice_id;
  SELECT * INTO STRICT row FROM public.claim_notification_receipts_atomic(200) claimed WHERE claimed.id=fixture.notice_id;
  PERFORM pg_temp.check_rules(public.complete_notification_outbox_atomic(row.id,row.claim_token),
    'the deployed Edge can complete pending receipts');
  PERFORM pg_temp.check_rules((SELECT delivered_at IS NOT NULL AND expo_ticket_id IS NULL AND push_token IS NULL
    AND ticketed_at IS NULL AND claimed_at IS NULL AND claim_token IS NULL FROM public.notification_outbox
    WHERE notification_outbox.id=fixture.notice_id), 'receipt completion clears legacy delivery state');
  token := 'ExponentPushToken[release-'||fixture.user_id||']';
  PERFORM public.register_push_token_atomic(fixture.user_id,token,repeat('a',64));
  PERFORM pg_temp.check_rules((SELECT push_token=token AND push_token_revocation_hash=repeat('a',64)
    FROM public.profiles WHERE profiles.id=fixture.user_id), 'the deployed Edge can register a push token');
  PERFORM pg_temp.check_rules(NOT public.revoke_push_token_atomic(token,repeat('b',64)), 'a wrong credential cannot revoke a token');
  PERFORM pg_temp.check_rules(public.revoke_push_token_atomic(token,repeat('a',64)), 'the deployed Edge can revoke a push token');
  PERFORM public.register_push_token_atomic(fixture.user_id,token,repeat('a',64));
  PERFORM pg_temp.check_rules(public.clear_push_token_for_user_atomic(fixture.user_id,token),
    'the deployed Edge can clear an invalid push token');
  UPDATE public.profiles SET push_token=token WHERE profiles.id=fixture.user_id;
  UPDATE public.profiles SET push_token=NULL WHERE profiles.id=fixture.user_id;
  PERFORM pg_temp.check_rules((SELECT push_token IS NULL AND push_token_revocation_hash IS NULL
    FROM public.profiles WHERE profiles.id=fixture.user_id), 'legacy fallback writes keep paired token state valid');
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category)
  VALUES('review:new-web-notice:'||fixture.member_id,fixture.member_id,'trade_completed','Trade','Completed','trade') RETURNING notification_outbox.id INTO v_notice_id;
  SELECT * INTO STRICT row FROM public.claim_notification_outbox_atomic(200) claimed WHERE claimed.id=v_notice_id;
  PERFORM pg_temp.check_rules(public.record_notification_outbox_ticket_atomic(v_notice_id,row.claim_token,'new-ticket-'||v_notice_id,token,0),
    'the deployed Edge can persist a newly sent Expo ticket');
  SELECT * INTO STRICT row FROM public.claim_notification_receipts_atomic(200) claimed WHERE claimed.id=v_notice_id;
  PERFORM pg_temp.check_rules(public.fail_notification_outbox_atomic(v_notice_id,row.claim_token,'retry'),
    'failed receipts can retry through the delivery queue');
  PERFORM pg_temp.check_rules((SELECT expo_ticket_id IS NULL AND push_token IS NULL AND ticketed_at IS NULL
    AND receipt_attempt_count=0 FROM public.notification_outbox WHERE notification_outbox.id=v_notice_id),
    'receipt retries clear their old ticket');
  UPDATE public.notification_outbox SET available_at=now() WHERE notification_outbox.id=v_notice_id;
  SELECT * INTO STRICT row FROM public.claim_notification_outbox_atomic(200) claimed WHERE claimed.id=v_notice_id;
  PERFORM pg_temp.check_rules(public.complete_notification_outbox_atomic(v_notice_id,row.claim_token), 'new web delivery can complete');
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category)
  VALUES('review:web-dead-letter:'||fixture.member_id,fixture.member_id,'trade_completed','Trade','Completed','trade') RETURNING notification_outbox.id INTO v_notice_id;
  SELECT * INTO STRICT row FROM public.claim_notification_outbox_atomic(200) claimed WHERE claimed.id=v_notice_id;
  PERFORM pg_temp.check_rules(public.dead_letter_notification_outbox_atomic(v_notice_id,row.claim_token,'permanent failure'),
    'new web delivery can stop permanent failures');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_notification_outbox_atomic(200) claimed WHERE claimed.id=v_notice_id),
    'permanently failed web delivery cannot be reclaimed');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
