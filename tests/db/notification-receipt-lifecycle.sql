BEGIN;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.handle_new_auth_user()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.handle_new_auth_user()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.handle_new_auth_user()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Auth profile trigger function is externally executable';
  END IF;
END $$;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000091001', 'authenticated', 'authenticated',
  'notification-receipts@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

INSERT INTO public.leagues (id, name, slug, commissioner_id, status)
VALUES (
  '00000000-0000-0000-0000-000000091101', 'Notification Receipts Test',
  'notification-receipts-test', '00000000-0000-0000-0000-000000091001', 'active'
);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES (
  '00000000-0000-0000-0000-000000091201',
  '00000000-0000-0000-0000-000000091101',
  '00000000-0000-0000-0000-000000091001', 'commissioner', 'Receipt Team'
);

DO $$
DECLARE
  v_id uuid;
  v_claim_token uuid;
  v_state text;
  v_row public.notification_outbox%ROWTYPE;
BEGIN
  BEGIN
    INSERT INTO public.notification_outbox (
      dedupe_key, member_id, event_type, title, body, category
    ) VALUES (
      'unsupported-category', '00000000-0000-0000-0000-000000091201',
      'waiver_processed', 'Waiver', 'Waiver body', 'waiver'
    );
    RAISE EXCEPTION 'Notification outbox accepted a non-trade category';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO public.notification_outbox (dedupe_key, member_id, event_type, title, body, category)
  VALUES (
    'receipt-global-outage', '00000000-0000-0000-0000-000000091201',
    'trade_offered', 'Trade', 'Trade body', 'trade'
  )
  RETURNING id INTO v_id;

  SELECT claim_token INTO v_claim_token
    FROM public.claim_notification_outbox_atomic(200, 60)
   WHERE id = v_id;
  IF NOT public.record_notification_outbox_ticket_atomic(
    v_id, v_claim_token, 'receipt-global-outage-ticket',
    'ExponentPushToken[receipt-global-outage]', 0
  ) THEN
    RAISE EXCEPTION 'Could not record global-outage receipt ticket';
  END IF;

  FOR v_attempt IN 1..13 LOOP
    UPDATE public.notification_outbox SET available_at = now() - interval '1 second' WHERE id = v_id;
    SELECT claim_token INTO v_claim_token
      FROM public.claim_notification_receipts_atomic(200, 60)
     WHERE id = v_id;
    SELECT public.defer_notification_receipt_state_atomic(
      v_id, v_claim_token, 'Global Expo receipt outage', 15, false
    ) INTO v_state;
    IF v_state <> 'deferred' THEN
      RAISE EXCEPTION 'Global outage release % returned %', v_attempt, v_state;
    END IF;
  END LOOP;

  SELECT * INTO v_row FROM public.notification_outbox WHERE id = v_id;
  IF v_row.receipt_attempt_count <> 0 OR v_row.dead_lettered_at IS NOT NULL
     OR v_row.expo_ticket_id IS NULL OR v_row.push_token IS NULL THEN
    RAISE EXCEPTION 'Global outages consumed ticket attempts or terminalized the row';
  END IF;

  FOR v_attempt IN 1..13 LOOP
    UPDATE public.notification_outbox SET available_at = now() - interval '1 second' WHERE id = v_id;
    SELECT claim_token INTO v_claim_token
      FROM public.claim_notification_receipts_atomic(200, 60)
     WHERE id = v_id;
    SELECT public.defer_notification_receipt_state_atomic(
      v_id, v_claim_token, 'Receipt not available yet', 15, true
    ) INTO v_state;
    IF v_state <> 'deferred' THEN
      RAISE EXCEPTION 'Per-ticket deferral % returned %', v_attempt, v_state;
    END IF;
  END LOOP;

  SELECT * INTO v_row FROM public.notification_outbox WHERE id = v_id;
  IF v_row.receipt_attempt_count <> 13 OR v_row.dead_lettered_at IS NOT NULL THEN
    RAISE EXCEPTION 'Per-ticket attempts terminalized before the age cutoff';
  END IF;

  UPDATE public.notification_outbox
     SET available_at = now() - interval '1 second', ticketed_at = now() - interval '24 hours'
   WHERE id = v_id;
  SELECT claim_token INTO v_claim_token
    FROM public.claim_notification_receipts_atomic(200, 60)
   WHERE id = v_id;
  SELECT public.defer_notification_receipt_state_atomic(
    v_id, v_claim_token, 'Receipt expired by age', 15, false
  ) INTO v_state;
  IF v_state <> 'dead_lettered' THEN
    RAISE EXCEPTION 'Aged receipt returned % instead of dead_lettered', v_state;
  END IF;

  SELECT * INTO v_row FROM public.notification_outbox WHERE id = v_id;
  IF v_row.dead_lettered_at IS NULL OR v_row.expo_ticket_id IS NOT NULL
     OR v_row.push_token IS NOT NULL OR v_row.ticketed_at IS NOT NULL
     OR v_row.receipt_attempt_count <> 13 OR v_row.last_error <> 'Receipt expired by age' THEN
    RAISE EXCEPTION 'Age terminalization did not scrub secrets and retain audit state';
  END IF;
END $$;

DO $$
DECLARE
  v_id uuid;
  v_claim_token uuid;
  v_row public.notification_outbox%ROWTYPE;
BEGIN
  INSERT INTO public.notification_outbox (dedupe_key, member_id, event_type, title, body, category)
  VALUES (
    'receipt-complete-scrub', '00000000-0000-0000-0000-000000091201',
    'trade_completed', 'Trade', 'Trade body', 'trade'
  ) RETURNING id INTO v_id;
  SELECT claim_token INTO v_claim_token FROM public.claim_notification_outbox_atomic(200, 60) WHERE id = v_id;
  PERFORM public.record_notification_outbox_ticket_atomic(
    v_id, v_claim_token, 'receipt-complete-ticket', 'ExponentPushToken[receipt-complete]', 0
  );
  SELECT claim_token INTO v_claim_token FROM public.claim_notification_receipts_atomic(200, 60) WHERE id = v_id;
  IF NOT public.complete_notification_outbox_atomic(v_id, v_claim_token) THEN
    RAISE EXCEPTION 'Could not complete receipt row';
  END IF;
  SELECT * INTO v_row FROM public.notification_outbox WHERE id = v_id;
  IF v_row.delivered_at IS NULL OR v_row.expo_ticket_id IS NOT NULL
     OR v_row.push_token IS NOT NULL OR v_row.ticketed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed receipt retained ticket secrets';
  END IF;

  INSERT INTO public.notification_outbox (dedupe_key, member_id, event_type, title, body, category)
  VALUES (
    'receipt-dead-letter-scrub', '00000000-0000-0000-0000-000000091201',
    'trade_completed', 'Trade', 'Trade body', 'trade'
  ) RETURNING id INTO v_id;
  SELECT claim_token INTO v_claim_token FROM public.claim_notification_outbox_atomic(200, 60) WHERE id = v_id;
  PERFORM public.record_notification_outbox_ticket_atomic(
    v_id, v_claim_token, 'receipt-dead-letter-ticket', 'ExponentPushToken[receipt-dead-letter]', 0
  );
  SELECT claim_token INTO v_claim_token FROM public.claim_notification_receipts_atomic(200, 60) WHERE id = v_id;
  IF NOT public.dead_letter_notification_outbox_atomic(v_id, v_claim_token, 'Permanent receipt failure') THEN
    RAISE EXCEPTION 'Could not dead-letter receipt row';
  END IF;
  SELECT * INTO v_row FROM public.notification_outbox WHERE id = v_id;
  IF v_row.dead_lettered_at IS NULL OR v_row.expo_ticket_id IS NOT NULL
     OR v_row.push_token IS NOT NULL OR v_row.ticketed_at IS NOT NULL
     OR v_row.last_error <> 'Permanent receipt failure' THEN
    RAISE EXCEPTION 'Dead-lettered receipt retained ticket secrets or lost audit state';
  END IF;
END $$;

ROLLBACK;
