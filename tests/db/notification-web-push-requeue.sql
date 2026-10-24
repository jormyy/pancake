BEGIN;
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
\ir ../../supabase/migrations/20261025000056_requeue_retired_push_receipts.sql
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM notification_outbox WHERE dedupe_key LIKE 'review:web-push-requeue:%'
    AND (expo_ticket_id IS NOT NULL OR push_token IS NOT NULL OR ticketed_at IS NOT NULL
      OR claim_token IS NOT NULL OR claimed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Retired Expo tickets keep notifications outside the web push queue';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM notification_outbox WHERE dedupe_key LIKE 'review:web-push-requeue:%'
    AND delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()) THEN
    RAISE EXCEPTION 'Retired Expo notifications are not available for web delivery';
  END IF;
END $$;
ROLLBACK;
