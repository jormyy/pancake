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
DECLARE f record; a uuid:=gen_random_uuid(); newest uuid:=gen_random_uuid(); oldest uuid:=gen_random_uuid(); actual uuid[];
BEGIN
  SELECT * INTO f FROM notif_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
  PERFORM notif_publish_announcement_atomic(f.league,'Keep league history',a);
  INSERT INTO league_announcements(id,league_id,author_member_id,body,published_at)
    VALUES(newest,f.league,f.member,'Newest',now()+interval '1 day'),(oldest,f.league,f.member,'Oldest',now()-interval '1 day');
  DELETE FROM league_members WHERE id=f.member;
  IF NOT EXISTS(SELECT 1 FROM league_announcements WHERE id=a AND author_member_id IS NULL AND body='Keep league history') THEN RAISE EXCEPTION 'Deleting the author must preserve announcement history'; END IF;
  PERFORM set_config('request.jwt.claim.sub',f.opponent::text,true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(id) INTO actual FROM notif_list_announcements(p_league_id=>f.league);
  IF actual IS DISTINCT FROM ARRAY[newest,a,oldest] THEN RAISE EXCEPTION 'Members must read authorless announcements newest first'; END IF;
  PERFORM set_config('request.jwt.claim.sub',f.outsider::text,true);
  BEGIN
    PERFORM * FROM notif_list_announcements(p_league_id=>f.league);
    RAISE EXCEPTION 'Outsider reads private announcements';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub','',true);
  INSERT INTO league_members(league_id,user_id,role) VALUES(f.league,f.owner,'commissioner');
  PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
  BEGIN PERFORM notif_publish_announcement_atomic(f.league,'Keep league history',a); RAISE EXCEPTION 'New membership reused former author request'; EXCEPTION WHEN unique_violation THEN NULL; END;
  IF (SELECT count(*) FROM notification_outbox WHERE event_type='commissioner_announcement' AND data->>'announcementId'=a::text)<>1 THEN RAISE EXCEPTION 'Author removal changed announcement dedupe'; END IF;
END $$;
ROLLBACK;
