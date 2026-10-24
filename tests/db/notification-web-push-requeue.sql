BEGIN;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS push_token text,
  ADD COLUMN IF NOT EXISTS push_token_revocation_hash text;
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS expo_ticket_id text,
  ADD COLUMN IF NOT EXISTS push_token text,
  ADD COLUMN IF NOT EXISTS ticketed_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_attempt_count integer NOT NULL DEFAULT 0;
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
    VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','{}','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
    VALUES(v_league,'Web push requeue',v_league::text,v_user,'active');
  INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(v_member,v_league,v_user,'commissioner','Home');
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,category,
    expo_ticket_id,push_token,ticketed_at,claimed_at,claim_token)
    VALUES('review:web-push-requeue:'||v_member,v_member,'trade_completed','Trade','Completed','trade',
      'review-ticket-'||v_member,'review-token-'||v_member,now(),now(),gen_random_uuid());
END $$;
\ir ../../supabase/migrations/20261026000080_retire_expo_push_storage.sql
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('profiles','notification_outbox')
      AND column_name IN ('push_token','push_token_revocation_hash','expo_ticket_id','ticketed_at','receipt_attempt_count'))
    OR to_regprocedure('private.normalize_legacy_push_token_write()') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass
      AND tgname='normalize_legacy_push_token_write')
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN ('notification_outbox_receipt_queue','notification_outbox_expo_ticket_unique','profiles_push_token_lookup')) THEN
    RAISE EXCEPTION 'Retired Expo storage remains';
  END IF;
  IF EXISTS(SELECT 1 FROM notification_outbox WHERE dedupe_key LIKE 'review:web-push-requeue:%'
    AND (claim_token IS NOT NULL OR claimed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Retired Expo tickets keep notifications outside the web push queue';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM notification_outbox WHERE dedupe_key LIKE 'review:web-push-requeue:%'
    AND delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()) THEN
    RAISE EXCEPTION 'Retired Expo notifications are not available for web delivery';
  END IF;
END $$;
DO $$
DECLARE
  v_row record;
  v_id uuid;
BEGIN
  SELECT claimed.* INTO STRICT v_row FROM public.claim_notification_outbox_atomic(200) claimed
  JOIN public.notification_outbox queued ON queued.id=claimed.id
  WHERE queued.dedupe_key LIKE 'review:web-push-requeue:%';
  IF NOT public.fail_notification_outbox_atomic(v_row.id,v_row.claim_token,'retry') THEN
    RAISE EXCEPTION 'Web push failure cannot release a claimed notification';
  END IF;
  v_id := v_row.id;
  UPDATE public.notification_outbox SET available_at=now() WHERE id=v_id;
  SELECT claimed.* INTO STRICT v_row FROM public.claim_notification_outbox_atomic(200) claimed
  WHERE claimed.id=v_id;
  IF NOT public.complete_notification_outbox_atomic(v_row.id,v_row.claim_token) THEN
    RAISE EXCEPTION 'Web push delivery cannot complete a retried notification';
  END IF;
  IF EXISTS(SELECT 1 FROM public.notification_outbox WHERE id=v_id
    AND (delivered_at IS NULL OR claimed_at IS NOT NULL OR claim_token IS NOT NULL OR last_error IS NOT NULL)) THEN
    RAISE EXCEPTION 'Delivered web push retains retry state';
  END IF;
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category)
  SELECT 'review:web-push-dead-letter:'||member_id,member_id,event_type,title,body,category
  FROM public.notification_outbox WHERE id=v_id RETURNING id INTO v_id;
  SELECT claimed.* INTO STRICT v_row FROM public.claim_notification_outbox_atomic(200) claimed
  WHERE claimed.id=v_id;
  IF NOT public.dead_letter_notification_outbox_atomic(v_row.id,v_row.claim_token,'permanent failure') THEN
    RAISE EXCEPTION 'Permanent web push failure cannot finish a claimed notification';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.notification_outbox WHERE id=v_id
    AND dead_lettered_at IS NOT NULL AND claimed_at IS NULL AND claim_token IS NULL
    AND delivered_at IS NULL AND last_error='permanent failure') THEN
    RAISE EXCEPTION 'Permanently failed web push retains its delivery lease';
  END IF;
  IF EXISTS(SELECT 1 FROM public.claim_notification_outbox_atomic(200) WHERE id=v_id) THEN
    RAISE EXCEPTION 'Permanently failed web push returns to delivery';
  END IF;
END $$;
ROLLBACK;
