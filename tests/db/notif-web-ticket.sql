\set ON_ERROR_STOP on
\getenv notif_test_db SUPABASE_DB_URL
\getenv notif_test_port PANCAKE_TEST_DB_PORT
\if :{?notif_test_db}
\else
  \echo SUPABASE_DB_URL is required
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
\if :{?notif_test_port}
\else
  \set notif_test_port 54322
\endif
SELECT set_config('notif.test_db', :'notif_test_db',false) \gset
SELECT set_config('notif.test_port', :'notif_test_port',false) \gset
DO $$ BEGIN
  IF current_setting('notif.test_port') !~ '^[0-9]+$' OR current_setting('notif.test_db') !~
    format('^postgres(ql)?://[^/@]+@(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$',current_setting('notif.test_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback database port is allowed';
  END IF;
END $$;
BEGIN;
CREATE TEMP TABLE notif_fixture AS SELECT gen_random_uuid() AS league,gen_random_uuid() AS other_league,
  gen_random_uuid() AS season,gen_random_uuid() AS prior_season,
  gen_random_uuid() AS owner,gen_random_uuid() AS opponent,gen_random_uuid() AS outsider,
  gen_random_uuid() AS member,gen_random_uuid() AS other_member,gen_random_uuid() AS foreign_member,
  gen_random_uuid() AS same_user_foreign_member;
INSERT INTO auth.users(id,email,raw_user_meta_data)
SELECT id,id::text || '@example.test',jsonb_build_object('username',id::text)
FROM notif_fixture f CROSS JOIN LATERAL unnest(ARRAY[f.owner,f.opponent,f.outsider]) id;
INSERT INTO leagues(id,name,slug,commissioner_id,status,weekly_add_limit)
SELECT league,'Notification fixture',league::text,owner,'offseason'::league_status,2 FROM notif_fixture
UNION ALL SELECT other_league,'Other fixture',other_league::text,outsider,'offseason'::league_status,2 FROM notif_fixture;
INSERT INTO league_members(id,league_id,user_id,role,team_name)
SELECT member,league,owner,'commissioner'::league_member_role,'Owner' FROM notif_fixture
UNION ALL SELECT other_member,league,opponent,'manager','Opponent' FROM notif_fixture
UNION ALL SELECT foreign_member,other_league,outsider,'commissioner','Outside' FROM notif_fixture
UNION ALL SELECT same_user_foreign_member,other_league,owner,'manager','Same user, other league' FROM notif_fixture;
INSERT INTO league_seasons(id,league_id,season_year,is_current)
SELECT prior_season,league,20025,false FROM notif_fixture
UNION ALL SELECT season,league,20026,true FROM notif_fixture;
INSERT INTO notification_preferences(user_id,event_settings)
SELECT owner,(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) FROM notif_fixture
UNION ALL SELECT opponent,(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) FROM notif_fixture;
DO $$
DECLARE f record; r record; receipt record;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  PERFORM private.notif_enqueue('trade_offered','web-ticket-protocol',f.league,f.member);
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE id IN(SELECT id FROM notification_outbox WHERE dedupe_key='trade_offered:web-ticket-protocol:' || f.member);
  IF r.id IS NULL OR notif_begin_web_atomic(r.id,r.claim_token)<>'send' THEN RAISE EXCEPTION 'web reservation failed'; END IF;
  IF NOT record_notification_outbox_ticket_atomic(r.id,r.claim_token,'synthetic-ticket','synthetic-token',0) THEN RAISE EXCEPTION 'Expo ticket persistence failed'; END IF;
  IF NOT notif_finish_web_atomic(r.id,r.claim_token,true) THEN RAISE EXCEPTION 'Web ack lost after Expo clears delivery lease'; END IF;
  IF NOT EXISTS(SELECT 1 FROM notification_outbox WHERE id=r.id AND web_delivered_at IS NOT NULL AND expo_ticket_id='synthetic-ticket') THEN RAISE EXCEPTION 'Both channel outcomes must persist'; END IF;
  IF notif_finish_web_atomic(r.id,gen_random_uuid(),true) THEN RAISE EXCEPTION 'Wrong web token accepted'; END IF;
  SELECT * INTO receipt FROM claim_notification_receipts_atomic(200,60) WHERE id=r.id;
  IF receipt.id IS NULL OR NOT complete_notification_outbox_atomic(receipt.id,receipt.claim_token) THEN RAISE EXCEPTION 'receipt completion failed'; END IF;
  IF EXISTS(SELECT 1 FROM claim_notification_outbox_atomic(200,60) WHERE id=r.id) THEN RAISE EXCEPTION 'delivered dual-channel event retried'; END IF;
  PERFORM private.notif_enqueue('trade_offered','web-known-failure',f.league,f.member);
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60)
    WHERE id IN(SELECT id FROM notification_outbox WHERE dedupe_key='trade_offered:web-known-failure:' || f.member);
  IF notif_begin_web_atomic(r.id,r.claim_token)<>'send' THEN RAISE EXCEPTION 'First Web Push attempt not reserved'; END IF;
  IF NOT notif_finish_web_atomic(r.id,r.claim_token,false) THEN RAISE EXCEPTION 'Known failure not recorded'; END IF;
  IF NOT fail_notification_outbox_atomic(r.id,r.claim_token,'known HTTP 503') THEN RAISE EXCEPTION 'Known failure not retried'; END IF;
  UPDATE notification_outbox SET available_at=now() WHERE id=r.id;
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE id=r.id;
  IF notif_begin_web_atomic(r.id,r.claim_token)<>'send' THEN RAISE EXCEPTION 'Known failure blocks the next Web Push attempt'; END IF;
  IF NOT notif_finish_web_atomic(r.id,r.claim_token,true) THEN RAISE EXCEPTION 'Retry success not recorded'; END IF;
  UPDATE notification_outbox SET claimed_at=now()-interval '61 seconds' WHERE id=r.id;
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE id=r.id;
  IF notif_begin_web_atomic(r.id,r.claim_token)<>'delivered' THEN RAISE EXCEPTION 'Retry sends a successful Web Push twice'; END IF;
  IF NOT complete_notification_outbox_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'Saved Web Push success cannot complete'; END IF;
  PERFORM private.notif_enqueue('trade_offered','web-unknown-outcome',f.league,f.member);
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60)
    WHERE id IN(SELECT id FROM notification_outbox WHERE dedupe_key='trade_offered:web-unknown-outcome:' || f.member);
  IF notif_begin_web_atomic(r.id,r.claim_token)<>'send' THEN RAISE EXCEPTION 'Unknown-outcome attempt not reserved'; END IF;
  UPDATE notification_outbox SET claimed_at=now()-interval '61 seconds' WHERE id=r.id;
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE id=r.id;
  IF notif_begin_web_atomic(r.id,r.claim_token)<>'attempted' THEN RAISE EXCEPTION 'Unknown Web Push outcome is sent twice'; END IF;
END $$;
ROLLBACK;
