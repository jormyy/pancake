BEGIN;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'local-waiver-outbox-test', true);
UPDATE public.trades SET expires_at=now()+interval '1 day',veto_window_expires_at=now()+interval '1 day';
UPDATE public.notification_outbox SET available_at=now()+interval '1 day';
DO $$
DECLARE
  actor uuid := gen_random_uuid();
  league uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  notice uuid;
  lease uuid;
  previous_lease uuid;
  invocations bigint;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(actor,actor::text||'@example.test','{}');
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status)
  VALUES(league,'Waiver notification queue',league::text,actor,'active');
  INSERT INTO public.league_members(id,league_id,user_id,team_name) VALUES(member,league,actor,'Manager');
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category)
  VALUES('waiver_result:'||member,member,'waiver_claim_succeeded','Waiver Claim Succeeded','Added','waiver') RETURNING id INTO notice;
  SELECT count(*) INTO invocations FROM public.edge_invocations WHERE function_name='process-trades';
  PERFORM public.invoke_process_trades_if_due();
  IF (SELECT count(*) FROM public.edge_invocations WHERE function_name='process-trades') <> invocations+1 THEN
    RAISE EXCEPTION 'A due waiver result does not wake the notification worker';
  END IF;
  SELECT claim_token INTO lease FROM public.claim_notification_outbox_atomic(200,60) WHERE id=notice;
  IF lease IS NULL THEN RAISE EXCEPTION 'A waiver result cannot be claimed'; END IF;
  IF EXISTS(SELECT 1 FROM public.claim_notification_outbox_atomic(200,60) WHERE id=notice) THEN
    RAISE EXCEPTION 'Concurrent workers claim the same waiver result';
  END IF;
  PERFORM public.fail_notification_outbox_atomic(notice,lease,'Web push HTTP 503');
  IF NOT EXISTS(SELECT 1 FROM public.notification_outbox WHERE id=notice AND attempt_count=1
    AND available_at>now() AND claimed_at IS NULL AND claim_token IS NULL AND delivered_at IS NULL) THEN
    RAISE EXCEPTION 'A failed waiver result does not retain its retry';
  END IF;
  IF EXISTS(SELECT 1 FROM public.claim_notification_outbox_atomic(200,60) WHERE id=notice) THEN
    RAISE EXCEPTION 'A failed waiver result ignores retry backoff';
  END IF;
  UPDATE public.notification_outbox SET available_at=now()-interval '1 second' WHERE id=notice;
  previous_lease:=lease;
  SELECT claim_token INTO lease FROM public.claim_notification_outbox_atomic(200,60) WHERE id=notice;
  IF lease IS NULL OR lease=previous_lease THEN RAISE EXCEPTION 'A waiver retry does not renew its lease'; END IF;
  IF public.complete_notification_outbox_atomic(notice,previous_lease) THEN
    RAISE EXCEPTION 'An old worker acknowledges a newer waiver lease';
  END IF;
  IF NOT public.complete_notification_outbox_atomic(notice,lease) THEN
    RAISE EXCEPTION 'A successful waiver result cannot complete';
  END IF;
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category)
  VALUES('waiver_result:'||member,member,'waiver_claim_succeeded','Waiver Claim Succeeded','Added','waiver')
  ON CONFLICT(dedupe_key) DO NOTHING;
  IF (SELECT count(*) FROM public.notification_outbox WHERE dedupe_key='waiver_result:'||member) <> 1
    OR EXISTS(SELECT 1 FROM public.claim_notification_outbox_atomic(200,60) WHERE id=notice) THEN
    RAISE EXCEPTION 'A replay sends a completed waiver result again';
  END IF;
END;
$$;
ROLLBACK;
