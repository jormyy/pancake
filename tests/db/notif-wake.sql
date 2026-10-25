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
DECLARE secret_name text; value text; id uuid;
BEGIN
  FOR secret_name,value IN VALUES('pancake_supabase_url','http://127.0.0.1:54321'),('pancake_edge_internal_token','synthetic-local-only') LOOP
    SELECT s.id INTO id FROM vault.secrets s WHERE s.name=secret_name;
    IF id IS NULL THEN PERFORM vault.create_secret(value,secret_name); ELSE PERFORM vault.update_secret(id,value); END IF;
  END LOOP;
END $$;
DO $$
DECLARE f record; d uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); n uuid:=gen_random_uuid(); before_count int;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  SELECT count(*) INTO before_count FROM edge_invocations WHERE function_name='process-trades';
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
    VALUES(d,f.league,f.season,'snake','in_progress',false,1,60);
  INSERT INTO snake_draft_picks(id,draft_id,member_id,round,pick_in_round,overall_pick,timer_expires_at)
    VALUES(p,d,f.member,1,1,1,clock_timestamp()+interval '60 seconds'),(n,d,f.other_member,1,2,2,NULL);
  IF (SELECT count(*) FROM edge_invocations WHERE function_name='process-trades')<>before_count+1 THEN RAISE EXCEPTION 'on-clock must wake the real internal dispatch path immediately'; END IF;
  PERFORM private.notif_draft_clock(d);
  IF (SELECT count(*) FROM edge_invocations WHERE function_name='process-trades')<>before_count+1 THEN RAISE EXCEPTION 'deduped on-clock must not wake again'; END IF;
  UPDATE snake_draft_picks SET skipped_at=clock_timestamp() WHERE id=p;
  PERFORM private.arm_next_snake_pick_timer(d,clock_timestamp()+interval '60 seconds');
  IF (SELECT count(*) FROM edge_invocations WHERE function_name='process-trades')<>before_count+2 THEN RAISE EXCEPTION 'next pick must wake after real skip transition'; END IF;
END $$;
ROLLBACK;
