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
DECLARE f record; d uuid; p uuid; saved int; until_at timestamptz; result record; auto_count int; clock_count int; i int; mock boolean;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
  VALUES('0029999070',20026,1,date '2026-10-20','BOS','NYK','Scheduled');
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT f.league,20026,r,m,m FROM unnest(ARRAY[f.member,f.other_member]) m CROSS JOIN generate_series(1,2) r;
  FOR i IN 1..4 LOOP
    INSERT INTO players(first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    VALUES('Synthetic','Backstop ' || i,'PG',ARRAY['PG'],0,i);
  END LOOP;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    SELECT 20026,w,date '2026-10-20'+(w-1)*7,date '2026-10-26'+(w-1)*7 FROM generate_series(1,24) w;
  UPDATE leagues SET playoff_entrants=2,playoff_round_lengths=ARRAY[1] WHERE id=f.league;
  PERFORM set_config('request.jwt.claim.sub',(SELECT commissioner_id::text FROM public.leagues WHERE id=f.league),true);
  PERFORM start_rookie_draft_atomic(f.league,2,false,60);
  SELECT id INTO d FROM drafts WHERE league_id = f.league AND NOT is_mock;
  SELECT timer_expires_at INTO until_at FROM snake_draft_picks WHERE draft_id = d AND overall_pick = 1;
  PERFORM pause_draft_atomic(d);
  SELECT timer_paused_remaining_seconds INTO saved FROM drafts WHERE id = d;
  IF saved NOT BETWEEN 59 AND 60 OR EXISTS (SELECT 1 FROM snake_draft_picks WHERE draft_id=d AND timer_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pause failed to save the remaining time';
  END IF;
  PERFORM resume_draft_atomic(d);
  IF NOT EXISTS (SELECT 1 FROM snake_draft_picks WHERE draft_id=d AND overall_pick=1
    AND timer_expires_at BETWEEN clock_timestamp()+make_interval(secs=>saved)-interval '1 second' AND clock_timestamp()+make_interval(secs=>saved)+interval '1 second') THEN
    RAISE EXCEPTION 'resume did not restore saved remaining time';
  END IF;
  PERFORM pause_draft_atomic(d);
  FOR result IN SELECT * FROM private.draft_timer_complete_opening_night(100,'2026-10-20 13:00:00+00') LOOP
    IF NOT result.picked THEN RAISE EXCEPTION 'opening-night completion failed: %',result.error_message; END IF;
  END LOOP;
  IF (SELECT count(*) FROM snake_draft_picks WHERE draft_id=d AND picked_at IS NOT NULL) <> 4 THEN RAISE EXCEPTION 'backstop missed a pick'; END IF;
  IF (SELECT count(*) FROM notification_outbox WHERE event_type='draft_auto_picked' AND data->>'draftId'=d::text) <> 4 THEN RAISE EXCEPTION 'backstop did not notify each auto-pick exactly once'; END IF;
  IF EXISTS (SELECT 1 FROM snake_draft_picks pick WHERE pick.draft_id=d AND
    (SELECT count(*) FROM draft_audit_logs audit JOIN notification_outbox queued ON queued.dedupe_key='draft_auto_picked:'||audit.id||':'||pick.member_id
      WHERE audit.draft_id=d AND audit.action='auto_pick' AND audit.metadata->'pick'->>'id'=pick.id::text) <> 1) THEN
    RAISE EXCEPTION 'backstop auto-pick recipient mismatch';
  END IF;
  IF (SELECT count(*) FROM notification_outbox WHERE event_type='draft_finished' AND data->>'draftId'=d::text) <> 2 THEN RAISE EXCEPTION 'backstop must finish once per member'; END IF;
  SELECT count(*) INTO auto_count FROM notification_outbox WHERE data->>'draftId'=d::text;
  PERFORM * FROM private.draft_timer_complete_opening_night(100,'2026-10-20 13:00:01+00');
  IF (SELECT count(*) FROM notification_outbox WHERE data->>'draftId'=d::text) <> auto_count THEN RAISE EXCEPTION 'backstop retry duplicated events'; END IF;
  UPDATE notification_outbox SET available_at=now() WHERE data->>'draftId'=d::text;
  PERFORM * FROM claim_notification_outbox_atomic(200,60);
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE data->>'draftId'=d::text AND event_type IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') AND suppression_reason IS DISTINCT FROM 'stale') THEN
    RAISE EXCEPTION 'already-made backstop picks can still send clock alerts';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',(SELECT commissioner_id::text FROM public.leagues WHERE id=f.league),true);
  PERFORM start_rookie_draft_atomic(f.league,1,true,60);
  SELECT id INTO d FROM drafts WHERE league_id=f.league AND is_mock;
  PERFORM pause_draft_atomic(d);
  PERFORM resume_draft_atomic(d);
  SELECT member_id INTO p FROM snake_draft_picks WHERE draft_id=d AND overall_pick=1;
  PERFORM auto_pick_snake_pick_atomic(d,p,'manual');
  PERFORM notif_scan_due_atomic();
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE data->>'draftId'=d::text) THEN RAISE EXCEPTION 'practice room sends real notifications'; END IF;
  RAISE NOTICE 'paused opening-day completion, saved timer resume, retry, and silent mock rooms pass';
END $$;
ROLLBACK;
