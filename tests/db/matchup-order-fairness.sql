\getenv post_order_db SUPABASE_DB_URL
\getenv post_order_port PANCAKE_TEST_DB_PORT
\if :{?post_order_db}
\else
  \echo SUPABASE_DB_URL is required
  \quit 3
\endif
\if :{?post_order_port}
\else
  \set post_order_port 54322
\endif
SELECT set_config('post.order_db', :'post_order_db',false) \gset
SELECT set_config('post.order_port', :'post_order_port',false) \gset
DO $$ BEGIN
  IF current_setting('post.order_port') !~ '^[0-9]+$' OR current_setting('post.order_db') !~
    format('^postgres(ql)?://[^/@]+@(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$',current_setting('post.order_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback database port is allowed';
  END IF;
END $$;
BEGIN;
DO $$
DECLARE
  league uuid; season uuid; next_season uuid; users uuid[]; members uuid[]; n int; i int; skipped boolean; payload jsonb; other jsonb; expected int; home_count int; away_count int; min_count int; max_count int; saved jsonb;
BEGIN
  FOREACH n IN ARRAY ARRAY[4,6,8,10,12,7,2] LOOP
    FOREACH skipped IN ARRAY ARRAY[false,true] LOOP
      league:=md5('post-league:'||n::text||skipped::text)::uuid; season:=md5('post-season:'||n::text||skipped::text)::uuid; next_season:=md5('post-next-season:'||n::text||skipped::text)::uuid; users:='{}'; members:='{}';
      IF n=2 THEN next_season:=CASE WHEN skipped THEN md5('post-next-season:2true')::uuid ELSE md5('post-fallback:false0')::uuid END; END IF;
      FOR i IN 1..n LOOP
        users:=array_append(users,gen_random_uuid()); members:=array_append(members,md5('post-member:'||n::text||skipped::text||i::text)::uuid);
        INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
        VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
        IF i=1 THEN
          INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week) VALUES(league,'Synthetic fair schedule',league::text,users[1],'setup',20);
          INSERT INTO league_seasons(id,league_id,season_year,is_current,skipped_weeks) VALUES(season,league,9324,true,CASE WHEN skipped THEN ARRAY[1] ELSE '{}'::int[] END);
          INSERT INTO league_seasons(id,league_id,season_year,is_current,skipped_weeks) VALUES(next_season,league,9325,false,CASE WHEN skipped THEN ARRAY[1] ELSE '{}'::int[] END);
        END IF;
        INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at) VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i,now()+i*interval '1 second');
      END LOOP;
      payload:=private.regular_season_matchup_payload(league,season,19);
      IF payload<>private.regular_season_matchup_payload(league,season,19) THEN RAISE EXCEPTION 'Schedule retry changes'; END IF;
      other:=private.regular_season_matchup_payload(league,next_season,19);
      IF current_setting('post.order_case',true)='season' THEN
        IF (SELECT jsonb_agg(r-'league_season_id') FROM jsonb_array_elements(payload) r)=(SELECT jsonb_agg(r-'league_season_id') FROM jsonb_array_elements(other) r) THEN RAISE EXCEPTION 'Next season repeats schedule'; END IF;
        CONTINUE;
      END IF;
      IF n=10 AND skipped AND (SELECT md5(jsonb_agg(jsonb_build_array(r->>'week_number',r->>'home_member_id',r->>'away_member_id'))::text) FROM jsonb_array_elements(payload) r)<>'d5f5117b05faf95de7a2b9a7c848c234' THEN RAISE EXCEPTION 'Stable season seed changed'; END IF;
      expected:=CASE WHEN skipped THEN 18 ELSE 19 END;
      IF jsonb_array_length(payload)<>expected*(n/2) THEN RAISE EXCEPTION 'Missing scheduled games'; END IF;
      IF skipped AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload) r WHERE (r->>'week_number')::int=1) THEN RAISE EXCEPTION 'Skipped week scheduled'; END IF;
      IF n=2 THEN next_season:=CASE WHEN skipped THEN md5('post-next-season:2true')::uuid ELSE md5('post-fallback:false0')::uuid END; END IF;
      FOR i IN 1..n LOOP
        SELECT count(*) FILTER(WHERE r->>'home_member_id'=members[i]::text),count(*) FILTER(WHERE r->>'away_member_id'=members[i]::text) INTO home_count,away_count FROM jsonb_array_elements(payload) r;
        IF abs(home_count-away_count)>1 THEN RAISE EXCEPTION 'Home imbalance: teams %, skipped %, member %, home %, away %',n,skipped,i,home_count,away_count; END IF;
      END LOOP;
      WITH pairs AS (SELECT a.id a,b.id b FROM unnest(members) a(id) CROSS JOIN unnest(members) b(id) WHERE a.id<b.id), counts AS (
        SELECT a,b,(SELECT count(*) FROM jsonb_array_elements(payload) r WHERE LEAST((r->>'home_member_id')::uuid,(r->>'away_member_id')::uuid)=a AND GREATEST((r->>'home_member_id')::uuid,(r->>'away_member_id')::uuid)=b) c FROM pairs)
      SELECT min(c),max(c) INTO min_count,max_count FROM counts;
      IF max_count-min_count>1 THEN RAISE EXCEPTION 'Unequal opponent counts'; END IF;
      IF EXISTS(WITH ordered AS (SELECT r->>'home_member_id' home,lag(r->>'home_member_id') OVER(PARTITION BY LEAST(r->>'home_member_id',r->>'away_member_id'),GREATEST(r->>'home_member_id',r->>'away_member_id') ORDER BY (r->>'week_number')::int) previous FROM jsonb_array_elements(payload) r) SELECT 1 FROM ordered WHERE home=previous) THEN RAISE EXCEPTION 'Repeated pair does not alternate home'; END IF;
      other:=private.regular_season_matchup_payload(league,next_season,19);
      IF (SELECT jsonb_agg(r-'league_season_id') FROM jsonb_array_elements(payload) r)=(SELECT jsonb_agg(r-'league_season_id') FROM jsonb_array_elements(other) r) THEN RAISE EXCEPTION 'Next season repeats schedule'; END IF;
      IF n=2 AND skipped THEN
        UPDATE league_seasons SET skipped_weeks='{}' WHERE id=season;
        PERFORM replace_regular_season_matchups_atomic(league,season);
        PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
        PERFORM update_league_settings_atomic(league,'{"skipped_weeks":[1]}'::jsonb);
        IF NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND week_number=1 AND is_voided) THEN RAISE EXCEPTION 'The settings path must preserve voided week-one history'; END IF;
        other:=private.regular_season_matchup_payload(league,next_season,19);
        IF (SELECT jsonb_agg(jsonb_build_array(week_number,home_member_id,away_member_id) ORDER BY week_number,home_member_id,away_member_id) FROM matchups WHERE league_season_id=season AND NOT is_voided)
          = (SELECT jsonb_agg(jsonb_build_array((r->>'week_number')::int,r->>'home_member_id',r->>'away_member_id') ORDER BY (r->>'week_number')::int,r->>'home_member_id',r->>'away_member_id') FROM jsonb_array_elements(other)r) THEN RAISE EXCEPTION 'Next season repeats live order when prior skipped-week history remains'; END IF;
      END IF;
      IF n=10 AND skipped THEN
        INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT 9324,w,date '9323-10-18'+(w-1)*7,date '9323-10-24'+(w-1)*7 FROM generate_series(1,26)w;
        PERFORM replace_regular_season_matchups_atomic(league,season);
        PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
        PERFORM update_league_settings_atomic(league,'{"playoff_start_week":19}'::jsonb);
        PERFORM update_league_settings_atomic(league,'{"playoff_start_week":20}'::jsonb);
        IF (SELECT jsonb_agg(jsonb_build_array(week_number,home_member_id,away_member_id) ORDER BY week_number,home_member_id,away_member_id) FROM matchups WHERE league_season_id=season)
          IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array((r->>'week_number')::int,r->>'home_member_id',r->>'away_member_id') ORDER BY (r->>'week_number')::int,r->>'home_member_id',r->>'away_member_id') FROM jsonb_array_elements(payload)r) THEN RAISE EXCEPTION 'Playoff settings trigger changes the season seed'; END IF;
        UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=5,away_points=1 WHERE league_season_id=season;
        UPDATE league_seasons SET matchup_order_version=0 WHERE id=season;
        SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) INTO saved FROM matchups m WHERE league_season_id=season;
        PERFORM replace_regular_season_matchups_atomic(league,season,true);
        IF saved IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM matchups m WHERE league_season_id=season) THEN RAISE EXCEPTION 'Existing finalized legacy matchups were rewritten'; END IF;
        BEGIN
          PERFORM update_league_settings_atomic(league,'{"playoff_start_week":19}'::jsonb);
          RAISE EXCEPTION 'Finalized schedule accepted new playoff timing';
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          IF position('schedule has started' IN SQLERRM)=0 THEN RAISE; END IF;
        END;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'PASS: seven sizes, skipped and full calendars, pair counts, home balance, alternating pairs, retries and season shuffle';
END;
$$;
ROLLBACK;
