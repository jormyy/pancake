\set ON_ERROR_STOP on
\getenv scoring_port PANCAKE_TEST_DB_PORT
\if :{?scoring_port}
\else
  \set scoring_port 54322
\endif
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT' = :'scoring_port' AS scoring_safe \gset
\if :scoring_safe
\else
  \echo Only the expected loopback database port is allowed
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
BEGIN;
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_home uuid := gen_random_uuid();
  v_away uuid := gen_random_uuid();
  v_home_user uuid := gen_random_uuid();
  v_away_user uuid := gen_random_uuid();
  v_match uuid := gen_random_uuid();
  v_year int;
  v_token jsonb;
  v_stale jsonb;
  v_match_ctid text;
  v_standing_ctid text;
  v_certificate_ctid text;
  v_matchup jsonb;
  v_standings jsonb;
BEGIN
  SELECT candidate INTO v_year FROM generate_series(7601,7700) candidate
    WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=candidate)
      AND NOT EXISTS(SELECT 1 FROM league_seasons WHERE season_year=candidate) LIMIT 1;
  IF v_year IS NULL THEN RAISE EXCEPTION 'No unused synthetic year'; END IF;
  INSERT INTO auth.users(id,email,raw_user_meta_data)
    VALUES(v_home_user,v_home_user||'@example.test',jsonb_build_object('username',v_home_user)),
      (v_away_user,v_away_user||'@example.test',jsonb_build_object('username',v_away_user));
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(v_league,'Synthetic score redelivery',v_league::text,v_home_user,'active');
  INSERT INTO league_members(id,league_id,user_id,team_name,role)
    VALUES(v_home,v_league,v_home_user,'Home','commissioner'),(v_away,v_league,v_away_user,'Away','manager');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,v_year,true);
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(v_year,1,'2024-01-01','2024-01-07');
  INSERT INTO matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type)
    VALUES(v_match,v_league,v_season,1,v_home,v_away,'regular_season');
  v_token := capture_score_inputs(v_season,1);
  v_matchup := jsonb_build_object('id',v_match,'input_token',v_token,'home_points',10,'away_points',5,
    'home_max_possible_points',20,'away_max_possible_points',10,'winner_member_id',v_home);
  v_standings := jsonb_build_array(jsonb_build_object('member_id',v_home,'wins',1,'losses',0,'ties',0,
    'points_for',10,'points_against',5,'max_possible_points',20,'waiver_priority',1));
  PERFORM finalize_score_week_atomic(v_league,v_season,1,jsonb_build_array(v_matchup),v_standings);
  IF NOT (SELECT is_finalized AND home_points=10 AND winner_member_id=v_home FROM matchups WHERE id=v_match) THEN
    RAISE EXCEPTION 'Initial finalization must publish the actual result';
  END IF;
  SELECT ctid::text INTO v_match_ctid FROM matchups WHERE id=v_match;
  SELECT ctid::text INTO v_standing_ctid FROM standings WHERE league_season_id=v_season;
  SELECT ctid::text INTO v_certificate_ctid FROM private.score_week_certificates WHERE league_season_id=v_season;
  v_token := capture_score_inputs(v_season,1);
  v_matchup := jsonb_set(v_matchup,'{input_token}',v_token);
  PERFORM finalize_score_week_atomic(v_league,v_season,1,jsonb_build_array(v_matchup),v_standings,
    clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 hour');
  IF (SELECT ctid::text FROM matchups WHERE id=v_match) <> v_match_ctid THEN RAISE EXCEPTION 'Unchanged delivery rewrites the matchup'; END IF;
  IF (SELECT ctid::text FROM standings WHERE league_season_id=v_season) <> v_standing_ctid THEN RAISE EXCEPTION 'Unchanged delivery rewrites standings'; END IF;
  IF (SELECT ctid::text FROM private.score_week_certificates WHERE league_season_id=v_season) <> v_certificate_ctid THEN RAISE EXCEPTION 'Unchanged delivery rewrites the certificate'; END IF;
  v_stale := v_token;
  v_matchup := jsonb_set(v_matchup,'{home_points}','11');
  v_standings := jsonb_set(v_standings,'{0,points_for}','11');
  PERFORM finalize_score_week_atomic(v_league,v_season,1,jsonb_build_array(v_matchup),v_standings);
  IF (SELECT home_points FROM matchups WHERE id=v_match) <> 11 OR
      (SELECT points_for FROM standings WHERE league_season_id=v_season) <> 11 THEN
    RAISE EXCEPTION 'A real correction must still update the result and standings';
  END IF;
  IF (SELECT input_token FROM private.score_week_certificates WHERE league_season_id=v_season)=v_stale THEN
    RAISE EXCEPTION 'A real correction must refresh the certificate';
  END IF;
  BEGIN
    PERFORM finalize_score_week_atomic(v_league,v_season,1,
      jsonb_build_array(jsonb_set(v_matchup,'{input_token}',v_stale)),v_standings);
    RAISE EXCEPTION 'Stale delivery was accepted';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
  END;
  RAISE NOTICE 'SYNTHETIC: identical delivery preserves rows; real corrections and stale-token rejection remain active';
END;
$$;
ROLLBACK;
