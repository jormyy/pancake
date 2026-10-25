BEGIN;
-- This SQL test checks transition guards using explicit synthetic results.
-- The actual scorer and its certificates are exercised in the scoring E2E tests.
CREATE FUNCTION pg_temp.certify_boundary_fixture(p_league uuid,p_season uuid,p_week int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE token jsonb; payload jsonb;
BEGIN
  token:=public.capture_score_inputs(p_season,p_week);
  SELECT jsonb_agg(jsonb_build_object('id',id,'winner_member_id',winner_member_id,
    'home_points',home_points,'away_points',away_points,
    'home_max_possible_points',home_max_possible_points,'away_max_possible_points',away_max_possible_points,
    'input_token',token)) INTO payload FROM matchups WHERE league_season_id=p_season AND week_number=p_week;
  PERFORM public.finalize_score_week_atomic(p_league,p_season,p_week,payload,'[]');
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.update_score_points_atomic(NULL,NULL,1,'[]');
    RAISE EXCEPTION 'Authenticated user can write scores';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.apply_season_boundary_after_grace(NULL,NULL,'rollover',now());
    RAISE EXCEPTION 'Authenticated user can run automatic boundaries';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.update_score_points_atomic(NULL,NULL,1,'[]');
    RAISE EXCEPTION 'Anonymous user can write scores';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.apply_season_boundary_after_grace(NULL,NULL,'rollover',now());
    RAISE EXCEPTION 'Anonymous user can run automatic boundaries';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;
DO $$
DECLARE
  league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); usr uuid; member uuid;
  ids uuid[]:='{}'; i int; result jsonb; match_id uuid; untouched jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM season_weeks WHERE season_year IN(8233,8234)) THEN RAISE EXCEPTION 'Fixture year occupied'; END IF;
  FOR i IN 1..4 LOOP
    usr:=gen_random_uuid(); member:=gen_random_uuid(); ids:=array_append(ids,member);
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(usr,'authenticated','authenticated',usr||'@example.test','x',now(),'{}','{}',now(),now());
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week) VALUES(league,'Synthetic boundary guards',league::text,usr,'active',2);
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8233,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(member,league,usr,CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Side '||i);
  END LOOP;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT 8233,w,'8233-02-01'::date+(w-1)*7,'8233-02-07'::date+(w-1)*7 FROM generate_series(1,3) w;
  FOR i IN 1..2 LOOP
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,home_points,away_points,is_finalized,winner_member_id,finalized_at)
    VALUES(league,season,1,ids[i],ids[5-i],'regular_season',10,5,true,ids[i],now());
  END LOOP;
  result:=public.apply_season_boundary_after_grace(league,season,'generate',timestamptz '8233-02-12 12:00 America/New_York');
  IF (result->>'applied')::boolean OR EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND matchup_type<>'regular_season') THEN
    RAISE EXCEPTION 'Generation ignored the last game date correction window';
  END IF;
  UPDATE matchups SET finalized_at=now()-interval '49 hours' WHERE league_season_id=season;
  result:=public.apply_season_boundary_after_grace(league,season,'generate',timestamptz '8233-02-13 00:00 America/New_York');
  IF (result->>'applied')::boolean THEN RAISE EXCEPTION 'Generation accepted uncertified legacy scores'; END IF;
  PERFORM pg_temp.certify_boundary_fixture(league,season,1);
  result:=public.apply_season_boundary_after_grace(league,season,'generate',timestamptz '8233-02-13 00:00 America/New_York');
  IF NOT (result->>'applied')::boolean THEN RAISE EXCEPTION 'Generation did not proceed after the game date correction window'; END IF;
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=10,away_points=5,finalized_at=now()
    WHERE league_season_id=season AND matchup_type='playoff_semifinal';
  SELECT id,to_jsonb(m) INTO match_id,untouched FROM matchups m WHERE league_season_id=season AND matchup_type='playoff_semifinal' LIMIT 1;
  IF public.update_score_points_atomic(league,season,2,jsonb_build_array(jsonb_build_object('id',match_id,'home_points',0,'away_points',20)))<>0 OR
    (SELECT to_jsonb(m) FROM matchups m WHERE id=match_id)<>untouched THEN
    RAISE EXCEPTION 'Separate point writer changed a finalized playoff result';
  END IF;
  BEGIN
    PERFORM public.update_score_points_atomic(league,season,3,jsonb_build_array(jsonb_build_object('id',match_id,'home_points',0,'away_points',20)));
    RAISE EXCEPTION 'Cross-week point write accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  result:=public.apply_season_boundary_after_grace(league,season,'advance',now());
  IF (result->>'applied')::boolean THEN RAISE EXCEPTION 'Advancement ignored renewed semifinal grace'; END IF;
  UPDATE matchups SET finalized_at=now()-interval '49 hours' WHERE league_season_id=season AND matchup_type='playoff_semifinal';
  PERFORM pg_temp.certify_boundary_fixture(league,season,2);
  result:=public.apply_season_boundary_after_grace(league,season,'advance',now());
  IF NOT (result->>'applied')::boolean THEN RAISE EXCEPTION 'Advancement did not proceed after grace'; END IF;
  PERFORM pg_temp.certify_boundary_fixture(league,season,1);
  result:=public.apply_season_boundary_after_grace(league,season,'rollover',now());
  IF (result->>'applied')::boolean THEN RAISE EXCEPTION 'Regular results cannot replace an undecided final'; END IF;
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=10,away_points=5,finalized_at=now()
    WHERE league_season_id=season AND matchup_type='playoff_final';
  result:=public.apply_season_boundary_after_grace(league,season,'rollover',now());
  IF (result->>'applied')::boolean OR (SELECT count(*) FROM league_seasons WHERE league_id=league)<>1 THEN
    RAISE EXCEPTION 'Rollover ignored renewed final grace';
  END IF;
  UPDATE matchups SET finalized_at=now()-interval '49 hours' WHERE league_season_id=season AND matchup_type='playoff_final';
  PERFORM pg_temp.certify_boundary_fixture(league,season,3);
  UPDATE matchups SET winner_member_id=NULL WHERE league_season_id=season AND matchup_type='playoff_final';
  PERFORM pg_temp.certify_boundary_fixture(league,season,3);
  PERFORM pg_temp.certify_boundary_fixture(league,season,1);
  result:=public.apply_season_boundary_after_grace(league,season,'rollover',now());
  IF (result->>'applied')::boolean THEN RAISE EXCEPTION 'A nonempty undecided final cannot pass the boundary gate'; END IF;
  UPDATE matchups SET winner_member_id=home_member_id,finalized_at=now()-interval '49 hours' WHERE league_season_id=season AND matchup_type='playoff_final';
  PERFORM pg_temp.certify_boundary_fixture(league,season,3);
  DELETE FROM private.score_week_certificates WHERE league_season_id=season AND week_number=1;
  result:=public.apply_season_boundary_after_grace(league,season,'rollover',now());
  IF (result->>'applied')::boolean OR (SELECT count(*) FROM league_seasons WHERE league_id=league)<>1 THEN
    RAISE EXCEPTION 'Rollover consumed a stale regular-season certificate';
  END IF;
  PERFORM pg_temp.certify_boundary_fixture(league,season,1);
  result:=public.apply_season_boundary_after_grace(league,season,'rollover',now());
  IF NOT (result->>'applied')::boolean OR (SELECT count(*) FROM league_seasons WHERE league_id=league)<>2 THEN
    RAISE EXCEPTION 'Rollover did not proceed after grace';
  END IF;
  result:=public.apply_season_boundary_after_grace(league,season,'rollover',now());
  IF (result->>'applied')::boolean OR (SELECT count(*) FROM league_seasons WHERE league_id=league)<>2 THEN
    RAISE EXCEPTION 'A stale expected season rolled over again';
  END IF;
  RAISE NOTICE 'PASS automatic generation/advancement/rollover grace, stale season, score immutability, scope, and client denials';
END;
$$;
ROLLBACK;
