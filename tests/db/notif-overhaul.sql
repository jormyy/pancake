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
DECLARE f record; e record; n int; a record;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  FOR e IN SELECT * FROM notif_event_catalog LOOP
    PERFORM private.notif_enqueue(e.event_type,'oracle',f.league,f.member);
    PERFORM private.notif_enqueue(e.event_type,'oracle',f.league,f.member);
    PERFORM private.notif_enqueue(e.event_type,'foreign',f.league,f.foreign_member);
    PERFORM private.notif_enqueue(e.event_type,'same-user-foreign',f.league,f.same_user_foreign_member);
    SELECT count(*) INTO n FROM notification_outbox WHERE dedupe_key = e.event_type || ':oracle:' || f.member;
    IF n <> 1 THEN RAISE EXCEPTION 'dedupe failed for %',e.event_type; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE member_id IN (f.foreign_member,f.same_user_foreign_member)) THEN
    RAISE EXCEPTION 'cross-league recipient escaped the filter';
  END IF;
  FOR a IN SELECT * FROM claim_notification_outbox_atomic(200,60) LOOP
    IF NOT complete_notification_outbox_atomic(a.id,a.claim_token) THEN RAISE EXCEPTION 'completion failed'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM claim_notification_outbox_atomic(200,60)) THEN RAISE EXCEPTION 'delivered event retried'; END IF;
  UPDATE notification_preferences SET event_settings = (SELECT jsonb_object_agg(event_type,false) FROM notif_event_catalog) WHERE user_id = f.owner;
  FOR e IN SELECT * FROM notif_event_catalog LOOP
    PERFORM private.notif_enqueue(e.event_type,'disabled',f.league,f.member);
  END LOOP;
  PERFORM * FROM claim_notification_outbox_atomic(200,60);
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE dedupe_key LIKE '%:disabled:%' AND (suppressed_at IS NULL OR suppression_reason <> 'preferences_disabled' OR delivered_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'suppression was not durably recorded';
  END IF;
  UPDATE notification_preferences SET event_settings = (SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) WHERE user_id = f.owner;
  UPDATE notification_outbox SET claimed_at = NULL,claim_token = NULL,available_at = now() - interval '1 day' WHERE member_id = f.member;
  IF EXISTS (SELECT 1 FROM claim_notification_outbox_atomic(200,60)) THEN RAISE EXCEPTION 'suppression did not survive resume'; END IF;
  UPDATE notification_preferences SET master_enabled = false WHERE user_id = f.owner;
  IF private.notif_preference_enabled(f.owner,'trade_offered','trade') THEN RAISE EXCEPTION 'master must win'; END IF;
  UPDATE notification_preferences SET master_enabled = true,category_settings = '{"trade":false}' WHERE user_id = f.owner;
  IF private.notif_preference_enabled(f.owner,'trade_offered','trade') THEN RAISE EXCEPTION 'category must win'; END IF;
  UPDATE notification_preferences SET category_settings = '{}' WHERE user_id = f.owner;
  UPDATE notification_preferences SET trade_enabled = false WHERE user_id = f.owner;
  IF private.notif_preference_enabled(f.owner,'trade_offered','trade') THEN RAISE EXCEPTION 'legacy trade gate must win'; END IF;
  IF NOT private.notif_preference_enabled(f.owner,'matchup_final','activity') THEN RAISE EXCEPTION 'legacy trade gate affected activity'; END IF;
  UPDATE notification_preferences SET trade_enabled = true,activity_enabled = false WHERE user_id = f.owner;
  IF NOT private.notif_preference_enabled(f.owner,'trade_offered','trade') THEN RAISE EXCEPTION 'legacy activity gate affected trade'; END IF;
  UPDATE notification_preferences SET activity_enabled = true WHERE user_id = f.owner;
END $$;
DO $$
DECLARE f record; d uuid; p uuid; m uuid; asset uuid; i int; s uuid; r record;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  FOR s IN SELECT unnest(ARRAY[f.prior_season,f.season]) LOOP
    d := gen_random_uuid();
    INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
    VALUES(d,f.league,s,'snake','pending',false,2,120);
    FOR i IN 1..4 LOOP
      m := CASE WHEN i % 2 = 1 THEN f.member ELSE f.other_member END;
      asset := gen_random_uuid();
      INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
      VALUES(asset,f.league,(SELECT season_year FROM league_seasons WHERE id = s),(i+1)/2,m,m);
      INSERT INTO snake_draft_picks(draft_id,draft_pick_id,member_id,round,pick_in_round,overall_pick)
      VALUES(d,asset,m,(i+1)/2,CASE WHEN i % 2 = 1 THEN 1 ELSE 2 END,i);
    END LOOP;
    UPDATE drafts SET status = 'in_progress' WHERE id = d;
    PERFORM private.arm_next_snake_pick_timer(d,clock_timestamp()+interval '2 minutes');
    PERFORM pause_draft_atomic(d);
    PERFORM resume_draft_atomic(d);
    PERFORM private.notif_draft_clock(d);
    SELECT id INTO p FROM snake_draft_picks WHERE draft_id = d AND overall_pick = 1;
    UPDATE snake_draft_picks SET timer_expires_at = clock_timestamp()-interval '1 second' WHERE id = p;
    UPDATE drafts SET timer_expiry_behavior = 'skip_pick' WHERE id = d;
    PERFORM * FROM process_expired_snake_pick_atomic(d);
    IF NOT EXISTS (SELECT 1 FROM snake_draft_picks WHERE id = p AND skipped_at IS NOT NULL) THEN RAISE EXCEPTION 'real skip did not execute'; END IF;
    FOR i IN 2..4 LOOP
      SELECT member_id INTO m FROM snake_draft_picks WHERE draft_id = d AND overall_pick = i;
      p := gen_random_uuid();
      INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
      VALUES(p,'Notify','Rookie ' || p::text,'PG',ARRAY['PG'],0,1);
      IF i = 2 THEN
        UPDATE drafts SET timer_expiry_behavior = 'auto_pick' WHERE id = d;
        UPDATE snake_draft_picks SET timer_expires_at = clock_timestamp()-interval '1 second' WHERE draft_id = d AND overall_pick = i;
        PERFORM * FROM process_expired_snake_pick_atomic(d);
        IF NOT EXISTS (SELECT 1 FROM snake_draft_picks WHERE draft_id = d AND overall_pick = i AND player_id IS NOT NULL) THEN RAISE EXCEPTION 'real expired timer auto-pick did not execute'; END IF;
      ELSE
        PERFORM auto_pick_snake_pick_atomic(d,m,'manual');
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM notification_outbox WHERE event_type = 'draft_on_clock' AND data->>'draftId' = d::text) <> 4 THEN RAISE EXCEPTION 'draft must log exactly one on-clock event per pick'; END IF;
    IF EXISTS (SELECT 1 FROM snake_draft_picks pick WHERE pick.draft_id = d AND
      (SELECT count(*) FROM notification_outbox o WHERE o.event_type = 'draft_on_clock' AND o.data->>'pickId' = pick.id::text AND o.member_id = pick.member_id) <> 1) THEN
      RAISE EXCEPTION 'on-clock recipient or dedupe failed';
    END IF;
    RAISE NOTICE 'two-season draft %: four picks, real skip, auto-picks, pause/resume; four on-clock rows',s;
  END LOOP;
END $$;
DO $$
DECLARE f record; p uuid := gen_random_uuid(); c uuid := gen_random_uuid(); pending_claim uuid := gen_random_uuid(); pending_player uuid := gen_random_uuid(); r record; n int;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions) VALUES(p,'Notify','Waiver','PG',ARRAY['PG']);
  INSERT INTO waiver_claims(id,league_id,league_season_id,member_id,player_id,priority_at_submission,process_date)
  VALUES(c,f.league,f.season,f.member,p,1,current_date);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions) VALUES(pending_player,'Notify','Pending','PG',ARRAY['PG']);
  INSERT INTO waiver_claims(id,league_id,league_season_id,member_id,player_id,priority_at_submission,process_date)
  VALUES(pending_claim,f.league,f.season,f.member,pending_player,1,current_date);
  UPDATE waiver_claims SET status = 'succeeded',processed_at = now() WHERE id = c;
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE event_type = 'waivers_processed' AND data->>'leagueSeasonId' = f.season::text) THEN RAISE EXCEPTION 'waiver summary precedes settlement'; END IF;
  UPDATE waiver_claims SET status = 'failed_roster',failure_reason = 'Synthetic full roster',processed_at = now() WHERE id = pending_claim;
  IF (SELECT count(*) FROM notification_outbox WHERE event_type = 'waivers_processed' AND data->>'leagueSeasonId' = f.season::text) <> 1 THEN RAISE EXCEPTION 'settled waiver summary missing or duplicated'; END IF;
  UPDATE waiver_claims SET status = 'succeeded' WHERE id = c;
  IF (SELECT count(*) FROM notification_outbox WHERE event_type = 'waiver_claim_won' AND data->>'claimId' = c::text) <> 1 THEN RAISE EXCEPTION 'waiver trigger missing or repeated'; END IF;
  INSERT INTO weekly_add_counts(league_id,league_season_id,member_id,week_number,add_count) VALUES(f.league,f.season,f.member,1,1);
  UPDATE weekly_add_counts SET add_count = 2 WHERE league_id = f.league AND week_number = 1;
  UPDATE weekly_add_counts SET add_count = 3 WHERE league_id = f.league AND week_number = 1;
  IF (SELECT count(*) FROM notification_outbox WHERE event_type = 'waiver_limit_reached' AND data->>'week' = '1') <> 1 THEN RAISE EXCEPTION 'weekly limit dedupe failed'; END IF;
  PERFORM private.notif_enqueue('trade_offered','web-state',f.league,f.member);
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE data->>'notificationEvent' = 'trade_offered' AND data->>'outboxId' IN (SELECT id::text FROM notification_outbox WHERE dedupe_key LIKE '%:web-state:%');
  IF notif_begin_web_atomic(r.id,r.claim_token) <> 'send' THEN RAISE EXCEPTION 'first web send not admitted'; END IF;
  IF NOT notif_finish_web_atomic(r.id,r.claim_token,true) THEN RAISE EXCEPTION 'web result not persisted'; END IF;
  IF NOT fail_notification_outbox_atomic(r.id,r.claim_token,'fake Expo outage') THEN RAISE EXCEPTION 'retry release failed'; END IF;
  UPDATE notification_outbox SET available_at = now() WHERE id = r.id;
  SELECT * INTO r FROM claim_notification_outbox_atomic(200,60) WHERE id = r.id;
  IF notif_begin_web_atomic(r.id,r.claim_token) <> 'delivered' THEN RAISE EXCEPTION 'web repeats after Expo retry'; END IF;
  IF NOT complete_notification_outbox_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'web completion failed'; END IF;
  IF EXISTS (SELECT 1 FROM claim_notification_outbox_atomic(200,60) WHERE id = r.id) THEN RAISE EXCEPTION 'web completed row retried'; END IF;
END $$;
DO $$
DECLARE f record; d uuid := gen_random_uuid(); p uuid := gen_random_uuid(); t timestamptz := '2030-01-01 00:00:00+00';
BEGIN
  SELECT * INTO f FROM notif_fixture;
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(d,f.league,f.season,'snake','in_progress',false,1);
  INSERT INTO snake_draft_picks(id,draft_id,member_id,round,pick_in_round,overall_pick,timer_expires_at)
  VALUES(p,d,f.member,1,1,1,t+interval '1 minute');
  PERFORM notif_scan_due_atomic(t-interval '1 microsecond');
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE event_type = 'draft_timer_expiring' AND data->>'pickId' = p::text) THEN RAISE EXCEPTION 'scanner fired outside the window'; END IF;
  PERFORM notif_scan_due_atomic(t);
  PERFORM notif_scan_due_atomic(t);
  IF (SELECT count(*) FROM notification_outbox WHERE event_type = 'draft_timer_expiring' AND data->>'pickId' = p::text) <> 1 THEN RAISE EXCEPTION 'scanner boundary or dedupe failed'; END IF;
END $$;
SELECT json_build_object('onClockRows',(SELECT json_agg(json_build_object(
  'id',o.id,'claim_token',gen_random_uuid(),'member_id',o.member_id,'title',o.title,'body',o.body,'data',o.data,'category',o.category))
  FROM notification_outbox o WHERE o.event_type = 'draft_on_clock' AND o.data ? 'draftId' AND o.data->>'draftId' IN
    (SELECT id::text FROM drafts WHERE status = 'completed')));
SELECT set_config('request.jwt.claim.sub',(SELECT owner::text FROM notif_fixture),true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM notification_preferences) <> 1 THEN RAISE EXCEPTION 'preferences disclosed another user'; END IF;
  BEGIN
    PERFORM * FROM notification_outbox;
    RAISE EXCEPTION 'authenticated can read outbox';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM notif_scan_due_atomic();
    RAISE EXCEPTION 'authenticated can invoke scanner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
ROLLBACK;
