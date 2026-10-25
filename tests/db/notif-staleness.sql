\getenv notif_test_db SUPABASE_DB_URL
\getenv notif_test_port PANCAKE_TEST_DB_PORT
\if :{?notif_test_db}
\else
  \echo SUPABASE_DB_URL is required
  \quit 3
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
DECLARE f record; d uuid; p uuid; n uuid; event text; state text; r record; queued uuid;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  DELETE FROM notification_outbox WHERE member_id IN (f.member,f.other_member);
  FOREACH event IN ARRAY ARRAY['draft_on_clock','draft_coming_soon','draft_timer_expiring'] LOOP
    FOREACH state IN ARRAY ARRAY['made','skipped','finished','expired','missing_deadline'] LOOP
      d := gen_random_uuid(); p := gen_random_uuid(); n := gen_random_uuid();
      INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
      VALUES(d,f.league,f.season,'snake','pending',false,1,60);
      INSERT INTO snake_draft_picks(id,draft_id,member_id,round,pick_in_round,overall_pick,timer_expires_at)
      VALUES(p,d,f.member,1,1,1,clock_timestamp()+interval '1 minute'),
        (n,d,f.other_member,1,2,2,clock_timestamp()+interval '2 minutes');
      UPDATE notification_preferences SET master_enabled=true WHERE user_id=f.owner;
      UPDATE drafts SET status = 'in_progress' WHERE id = d;
      DELETE FROM notification_outbox WHERE data->>'draftId' = d::text;
      PERFORM private.notif_enqueue(event,state || d,f.league,f.member,jsonb_build_object('draftId',d,'pickId',p));
      IF state = 'made' THEN UPDATE snake_draft_picks SET picked_at = now() WHERE id = p;
      ELSIF state = 'skipped' THEN UPDATE snake_draft_picks SET skipped_at = now() WHERE id = p;
      ELSIF state = 'finished' THEN UPDATE drafts SET status = 'completed' WHERE id = d;
      ELSIF state = 'expired' THEN UPDATE snake_draft_picks SET timer_expires_at = clock_timestamp()-interval '1 second' WHERE id = p;
      ELSE UPDATE snake_draft_picks SET timer_expires_at = NULL WHERE id = p;
      END IF;
      IF event='draft_on_clock' AND state='expired' THEN UPDATE notification_preferences SET master_enabled=false WHERE user_id=f.owner; END IF;
      PERFORM * FROM claim_notification_outbox_atomic(200,60);
      IF NOT EXISTS (SELECT 1 FROM notification_outbox WHERE dedupe_key = event || ':' || state || d || ':' || f.member
        AND suppressed_at IS NOT NULL AND suppression_reason = 'stale' AND delivered_at IS NULL) THEN
        RAISE EXCEPTION 'stale % for % was not durably suppressed',event,state;
      END IF;
      UPDATE notification_preferences SET master_enabled=true WHERE user_id=f.owner;
      UPDATE drafts SET status = 'in_progress' WHERE id = d;
      UPDATE snake_draft_picks SET picked_at = NULL,skipped_at = NULL,timer_expires_at = clock_timestamp()+interval '1 minute' WHERE id = p;
      IF EXISTS (SELECT 1 FROM claim_notification_outbox_atomic(200,60) c WHERE c.id IN
        (SELECT id FROM notification_outbox WHERE dedupe_key = event || ':' || state || d || ':' || f.member)) THEN
        RAISE EXCEPTION 'stale notification resurrected after resume';
      END IF;
      DELETE FROM notification_outbox WHERE data->>'draftId' = d::text;
      UPDATE drafts SET status = 'completed' WHERE id = d;
    END LOOP;
  END LOOP;
  UPDATE notification_preferences SET master_enabled=true WHERE user_id=f.owner;
  UPDATE drafts SET status='completed' WHERE id=d;
  d := gen_random_uuid(); p := gen_random_uuid();
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
  VALUES(d,f.league,f.season,'snake','in_progress',false,1,60);
  INSERT INTO snake_draft_picks(id,draft_id,member_id,round,pick_in_round,overall_pick,timer_expires_at)
  VALUES(p,d,f.member,1,1,1,clock_timestamp()+interval '1 minute');
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE data->>'pickId' = p::text AND data->>'notificationEvent' = 'draft_on_clock';
  IF r.id IS NULL THEN RAISE EXCEPTION 'live clock was not claimed'; END IF;
  IF NOT notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'live clock was suppressed'; END IF;
  PERFORM pause_draft_atomic(d);
  UPDATE notification_preferences SET master_enabled=false WHERE user_id=f.owner;
  IF notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'pause after claim escaped send-time gate'; END IF;
  IF NOT EXISTS (SELECT 1 FROM notification_outbox WHERE id = r.id AND suppression_reason IS NULL AND suppressed_at IS NULL AND claim_token IS NULL) THEN
    RAISE EXCEPTION 'pause after claim must release the lease without terminal suppression';
  END IF;
  PERFORM resume_draft_atomic(d);
  UPDATE notification_outbox SET available_at=now() WHERE id=r.id;
  PERFORM * FROM claim_notification_outbox_atomic(200,60);
  IF NOT EXISTS (SELECT 1 FROM notification_outbox WHERE id=r.id AND suppression_reason='preferences_disabled' AND suppressed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'resume must still apply send-time opt-out durably';
  END IF;
  UPDATE notification_preferences SET master_enabled=true WHERE user_id=f.owner;
  UPDATE drafts SET status='completed' WHERE id=d;
  d := gen_random_uuid(); p := gen_random_uuid();
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
  VALUES(d,f.league,f.season,'snake','in_progress',false,1,60);
  INSERT INTO snake_draft_picks(id,draft_id,member_id,round,pick_in_round,overall_pick,timer_expires_at)
  VALUES(p,d,f.member,1,1,1,'2030-01-01 00:01:00+00');
  PERFORM notif_scan_due_atomic('2030-01-01 00:01:00+00');
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE event_type='draft_timer_expiring' AND data->>'pickId'=p::text) THEN
    RAISE EXCEPTION 'scanner included an already-expired deadline';
  END IF;
  PERFORM notif_scan_due_atomic('2030-01-01 00:00:00+00');
  PERFORM notif_scan_due_atomic('2030-01-01 00:00:00+00');
  IF (SELECT count(*) FROM notification_outbox WHERE event_type='draft_timer_expiring' AND data->>'pickId'=p::text) <> 1 THEN
    RAISE EXCEPTION 'scanner one-minute inclusive upper boundary failed';
  END IF;
  PERFORM private.notif_enqueue('trade_offered','gate-preferences',f.league,f.member);
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE data->>'notificationEvent'='trade_offered';
  IF r.id IS NULL THEN RAISE EXCEPTION 'preference gate fixture was not claimed'; END IF;
  UPDATE notification_preferences SET master_enabled=false WHERE user_id=f.owner;
  IF notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'preference change after claim escaped send-time gate'; END IF;
  IF NOT EXISTS (SELECT 1 FROM notification_outbox WHERE id=r.id AND suppressed_at IS NOT NULL AND suppression_reason='preferences_disabled' AND delivered_at IS NULL) THEN
    RAISE EXCEPTION 'send-time preference suppression is not durable';
  END IF;
  UPDATE notification_preferences SET master_enabled=true WHERE user_id=f.owner;
  IF notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'suppressed admission resurrected'; END IF;
  RAISE NOTICE '15 terminal stale states, temporary pause, durable opt-out after resume, changes after claim, and scanner boundaries pass';
END $$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM notif_admit_delivery_atomic(gen_random_uuid(),gen_random_uuid());
    RAISE EXCEPTION 'authenticated can admit another member notification';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
ROLLBACK;
