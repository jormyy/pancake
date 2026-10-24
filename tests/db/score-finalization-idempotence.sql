BEGIN;
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_home uuid := gen_random_uuid();
  v_away uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_matchup uuid := gen_random_uuid();
  v_payload jsonb;
  v_standings jsonb;
  v_matchup_tid tid;
  v_standing_tid tid;
  v_read timestamptz := now() - interval '2 days';
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
    SELECT id,'authenticated','authenticated',id||'@example.test','{}','{}' FROM unnest(ARRAY[v_user,v_other]) id;
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
    VALUES(v_league,'Score finalization idempotence',v_league::text,v_user,'active');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,8993,true);
  INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES
    (v_home,v_league,v_user,'commissioner','Home'),(v_away,v_league,v_other,'manager','Away');
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    VALUES(8993,1,'2026-01-05','2026-01-11');
  INSERT INTO matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,
    matchup_type,home_points,away_points) VALUES(v_matchup,v_league,v_season,1,v_home,v_away,'regular_season',10,5);
  v_payload := jsonb_build_array(jsonb_build_object('id',v_matchup,'winner_member_id',v_home,
    'home_points',10,'away_points',5,'home_max_possible_points',12,'away_max_possible_points',8,
    'score_read_started_at',v_read,'input_token',capture_score_inputs(v_season,1)));
  v_standings := jsonb_build_array(jsonb_build_object('member_id',v_home,'wins',1,'losses',0,'ties',0,
    'points_for',10,'points_against',5,'max_possible_points',12,'waiver_priority',2,'created_at',v_read));
  PERFORM finalize_score_week_atomic(v_league,v_season,1,v_payload,v_standings,v_read,v_read);
  SELECT ctid INTO v_matchup_tid FROM matchups WHERE id=v_matchup;
  SELECT ctid INTO v_standing_tid FROM standings WHERE league_season_id=v_season AND member_id=v_home;
  DELETE FROM private.score_week_certificates WHERE league_season_id=v_season;
  v_payload := jsonb_set(jsonb_set(v_payload,'{0,score_read_started_at}',to_jsonb(now())),
    '{0,input_token}',capture_score_inputs(v_season,1));
  v_standings := jsonb_set(jsonb_set(v_standings,'{0,waiver_priority}','9'),'{0,created_at}',to_jsonb(now()));
  PERFORM finalize_score_week_atomic(v_league,v_season,1,v_payload,v_standings);
  IF (SELECT ctid FROM matchups WHERE id=v_matchup) IS DISTINCT FROM v_matchup_tid THEN
    RAISE EXCEPTION 'Unchanged finalization rewrites the matchup';
  END IF;
  IF (SELECT score_read_started_at FROM matchups WHERE id=v_matchup) IS DISTINCT FROM v_read THEN
    RAISE EXCEPTION 'Unchanged finalization advances the score read timestamp';
  END IF;
  IF (SELECT ctid FROM standings WHERE league_season_id=v_season AND member_id=v_home) IS DISTINCT FROM v_standing_tid THEN
    RAISE EXCEPTION 'Unchanged scores rewrite historical standings';
  END IF;
  IF (SELECT waiver_priority FROM standings WHERE league_season_id=v_season AND member_id=v_home) <> 2 THEN
    RAISE EXCEPTION 'Replay changes the historical waiver priority';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.score_week_certificates WHERE league_season_id=v_season AND week_number=1) THEN
    RAISE EXCEPTION 'Unchanged finalization does not refresh its certificate';
  END IF;
  v_payload := jsonb_set(jsonb_set(v_payload,'{0,home_points}','11'),'{0,input_token}',capture_score_inputs(v_season,1));
  v_standings := jsonb_set(v_standings,'{0,points_for}','11');
  PERFORM finalize_score_week_atomic(v_league,v_season,1,v_payload,v_standings);
  IF (SELECT home_points FROM matchups WHERE id=v_matchup) <> 11
    OR (SELECT points_for FROM standings WHERE league_season_id=v_season AND member_id=v_home) <> 11 THEN
    RAISE EXCEPTION 'Changed scores do not update matchups and standings';
  END IF;
  IF (SELECT waiver_priority FROM standings WHERE league_season_id=v_season AND member_id=v_home) <> 2 THEN
    RAISE EXCEPTION 'A score correction changes the historical waiver priority';
  END IF;
END $$;
ROLLBACK;
