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
INSERT INTO leagues(id,name,slug,commissioner_id,status,weekly_add_limit,playoff_entrants,playoff_round_lengths)
SELECT league,'Notification fixture',league::text,owner,'offseason'::league_status,2,2,ARRAY[1] FROM notif_fixture
UNION ALL SELECT other_league,'Other fixture',other_league::text,outsider,'offseason'::league_status,2,2,ARRAY[1] FROM notif_fixture;
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
DECLARE f record; d uuid; p uuid; timer int; r record; expiry uuid; initial_deadline timestamptz; resumed_deadline timestamptz;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  UPDATE notification_preferences SET event_settings=(SELECT jsonb_object_agg(event_type,event_type IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring')) FROM notif_event_catalog)
    WHERE user_id IN (f.owner,f.opponent);
  FOREACH timer IN ARRAY ARRAY[60,604800] LOOP
    UPDATE leagues SET status='offseason' WHERE id=f.league;
    INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
      SELECT f.league,20026,1,m,m FROM unnest(ARRAY[f.member,f.other_member]) m
      ON CONFLICT DO NOTHING;
    SELECT (start_rookie_draft_atomic(f.league,1,false,timer)->>'id')::uuid INTO d;
    SELECT id,timer_expires_at INTO p,initial_deadline FROM snake_draft_picks WHERE draft_id=d AND overall_pick=1;
    PERFORM notif_scan_due_atomic(initial_deadline-interval '30 seconds');
    SELECT id INTO expiry FROM notification_outbox WHERE event_type='draft_timer_expiring' AND data->>'pickId'=p::text;
    IF expiry IS NULL THEN RAISE EXCEPTION 'real scanner did not enqueue expiry'; END IF;
    CREATE TEMP TABLE paused_claims ON COMMIT DROP AS SELECT * FROM claim_notification_outbox_atomic(200,60)
      WHERE data->>'draftId'=d::text;
    PERFORM pause_draft_atomic(d);
    FOR r IN SELECT * FROM paused_claims LOOP
      IF notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'paused claimed alert admitted'; END IF;
      IF EXISTS(SELECT 1 FROM notification_outbox WHERE id=r.id AND (suppressed_at IS NOT NULL OR claim_token IS NOT NULL)) THEN
        RAISE EXCEPTION 'paused admission must release its lease without suppression';
      END IF;
    END LOOP;
    UPDATE notification_preferences SET master_enabled=false WHERE user_id IN (f.owner,f.opponent);
    PERFORM * FROM claim_notification_outbox_atomic(200,60);
    IF EXISTS(SELECT 1 FROM notification_outbox WHERE data->>'draftId'=d::text AND event_type IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') AND suppressed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'paused alerts consumed the send-time preference decision';
    END IF;
    UPDATE notification_preferences SET master_enabled=true WHERE user_id IN (f.owner,f.opponent);
    PERFORM pg_sleep(0.1);
    PERFORM resume_draft_atomic(d);
    SELECT timer_expires_at INTO resumed_deadline FROM snake_draft_picks WHERE id=p;
    IF resumed_deadline<=initial_deadline THEN RAISE EXCEPTION 'resume did not move deadline'; END IF;
    IF (SELECT count(*) FROM notification_outbox WHERE id=expiry AND event_type='draft_timer_expiring')<>1 THEN
      RAISE EXCEPTION 'resume replaced expiry occurrence';
    END IF;
    IF timer=604800 THEN
      IF NOT EXISTS(SELECT 1 FROM notification_outbox WHERE id=expiry AND available_at=resumed_deadline-interval '1 minute') THEN
        RAISE EXCEPTION 'expiry window did not follow resumed deadline';
      END IF;
      UPDATE notification_outbox SET available_at=clock_timestamp() WHERE id=expiry;
      IF EXISTS(SELECT 1 FROM claim_notification_outbox_atomic(200,60) WHERE id=expiry) THEN
        RAISE EXCEPTION 'old expiry alert escaped the resumed one-minute window';
      END IF;
      UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=p;
    END IF;
    UPDATE notification_outbox SET available_at=now() WHERE id=expiry;
    SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE id=expiry;
    IF r.id IS NULL THEN RAISE EXCEPTION 'resumed expiry not claimable inside its new window'; END IF;
    UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=p;
    IF notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'expiry admitted outside current deadline window'; END IF;
    IF EXISTS(SELECT 1 FROM notification_outbox WHERE id=expiry AND (suppressed_at IS NOT NULL OR admitted_at IS NOT NULL OR claim_token IS NOT NULL)) THEN
      RAISE EXCEPTION 'future expiry admission must defer without terminal state';
    END IF;
    UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=p;
    PERFORM pause_draft_atomic(d);
    PERFORM resume_draft_atomic(d);
    UPDATE notification_outbox SET available_at=now() WHERE id=expiry;
    SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE id=expiry;
    IF r.id IS NULL OR NOT notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'expiry did not rearm on same row'; END IF;
    PERFORM complete_notification_outbox_atomic(r.id,r.claim_token);
    PERFORM pause_draft_atomic(d);
    PERFORM resume_draft_atomic(d);
    IF EXISTS(SELECT 1 FROM claim_notification_outbox_atomic(200,60) WHERE id=expiry) THEN RAISE EXCEPTION 'delivered expiry repeated after pause'; END IF;
    IF (SELECT count(*) FROM notification_outbox WHERE event_type='draft_timer_expiring' AND data->>'pickId'=p::text)<>1 THEN RAISE EXCEPTION 'expiry dedupe changed'; END IF;
    DROP TABLE paused_claims;
    UPDATE drafts SET status='completed' WHERE id=d;
    DELETE FROM snake_draft_picks WHERE draft_id=d;
    DELETE FROM draft_orders WHERE draft_id=d;
    DELETE FROM draft_picks WHERE league_id=f.league AND season_year=20026;
    DELETE FROM drafts WHERE id=d;
  END LOOP;
  RAISE NOTICE '60-second and seven-day pause-after-claim, current expiry windows, same-row resume, preference timing, and delivered dedupe pass';
END $$;
ROLLBACK;
