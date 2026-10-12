BEGIN;
DO $$
DECLARE
  league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); usr uuid; member uuid;
  ids uuid[]:='{}'; seeds uuid[]; corrected uuid; i int; restored boolean;
BEGIN
  IF EXISTS(SELECT 1 FROM season_weeks WHERE season_year=8232) THEN RAISE EXCEPTION 'Fixture year occupied'; END IF;
  FOR i IN 1..10 LOOP
    usr:=gen_random_uuid(); member:=gen_random_uuid(); ids:=array_append(ids,member);
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(usr,'authenticated','authenticated',usr||'@example.test','x',now(),'{}','{}',now(),now());
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week) VALUES(league,'Synthetic seed correction',league::text,usr,'active',20);
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8232,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(member,league,usr,CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Side '||i);
  END LOOP;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT 8232,w,'8232-02-01'::date+(w-20)*7,'8232-02-07'::date+(w-20)*7 FROM generate_series(20,22) w;
  FOR i IN 1..5 LOOP
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,home_points,away_points,is_finalized)
    VALUES(league,season,1,ids[i],ids[11-i],'regular_season',0,0,true);
  END LOOP;
  SELECT array_agg(member_id ORDER BY seed_rank) INTO seeds FROM private.playoff_seed_rankings(league,season,20);
  PERFORM generate_playoff_bracket_atomic(league);
  UPDATE matchups SET is_finalized=true,winner_member_id=away_member_id WHERE league_season_id=season AND matchup_type='playoff_quarterfinal';
  SELECT id INTO corrected FROM matchups WHERE league_season_id=season AND matchup_type='regular_season' AND seeds[3] IN(home_member_id,away_member_id);
  UPDATE matchups SET winner_member_id=seeds[3],home_points=CASE WHEN home_member_id=seeds[3] THEN 100 ELSE 0 END,away_points=CASE WHEN away_member_id=seeds[3] THEN 100 ELSE 0 END WHERE id=corrected;
  PERFORM advance_playoff_bracket_atomic(league);
  SELECT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND matchup_type='playoff_semifinal' AND seeds[3] IN(home_member_id,away_member_id)) INTO restored;
  RAISE NOTICE 'actual eliminated_seed3_restored=%, original_bye_count=%',restored,(SELECT count(*) FROM matchups WHERE league_season_id=season AND matchup_type='playoff_semifinal' AND home_member_id IN(seeds[1],seeds[2]));
  IF restored THEN RAISE EXCEPTION 'An eliminated quarterfinal team returned as a semifinal bye'; END IF;
END;
$$;
ROLLBACK;

-- Legacy integrity controls, including exact unchanged-state and authoritative snapshot recovery.
BEGIN;
DO $$
DECLARE
  league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); usr uuid; member uuid;
  ids uuid[]:='{}'; seeds uuid[]; corrected uuid; i int; restored boolean; before_state jsonb; result jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM season_weeks WHERE season_year=8232) THEN RAISE EXCEPTION 'Fixture year occupied'; END IF;
  FOR i IN 1..10 LOOP
    usr:=gen_random_uuid(); member:=gen_random_uuid(); ids:=array_append(ids,member);
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(usr,'authenticated','authenticated',usr||'@example.test','x',now(),'{}','{}',now(),now());
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week) VALUES(league,'Synthetic seed correction',league::text,usr,'active',20);
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8232,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(member,league,usr,CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Side '||i);
  END LOOP;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT 8232,w,'8232-02-01'::date+(w-20)*7,'8232-02-07'::date+(w-20)*7 FROM generate_series(20,22) w;
  FOR i IN 1..5 LOOP
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,home_points,away_points,is_finalized)
    VALUES(league,season,1,ids[i],ids[11-i],'regular_season',0,0,true);
  END LOOP;
  SELECT array_agg(member_id ORDER BY seed_rank) INTO seeds FROM private.playoff_seed_rankings(league,season,20);
  PERFORM generate_playoff_bracket_atomic(league);
  UPDATE league_seasons SET playoff_seed_member_ids=NULL WHERE id=season; -- Explicit legacy-shape fixture only.
  UPDATE matchups SET is_finalized=true,winner_member_id=away_member_id WHERE league_season_id=season AND matchup_type='playoff_quarterfinal';
  SELECT id INTO corrected FROM matchups WHERE league_season_id=season AND matchup_type='regular_season' AND seeds[3] IN(home_member_id,away_member_id);
  UPDATE matchups SET winner_member_id=seeds[3],home_points=CASE WHEN home_member_id=seeds[3] THEN 100 ELSE 0 END,away_points=CASE WHEN away_member_id=seeds[3] THEN 100 ELSE 0 END WHERE id=corrected;
  SELECT jsonb_build_object(
    'league',(SELECT to_jsonb(l) FROM leagues l WHERE id=league),
    'season',(SELECT to_jsonb(s) FROM league_seasons s WHERE id=season),
    'matchups',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM matchups m WHERE league_season_id=season),
    'ties',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM rps_challenges r WHERE league_season_id=season)) INTO before_state;
  result:=generate_playoff_bracket_atomic(league);
  IF result->>'skipped'<>'true' THEN RAISE EXCEPTION 'Existing legacy bracket generation retry was not a no-op'; END IF;
  BEGIN
    PERFORM advance_playoff_bracket_atomic(league);
    RAISE EXCEPTION 'Missing original seed evidence must block semifinal generation' USING ERRCODE='P9999';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'Original playoff seed order is missing.%' THEN RAISE; END IF;
  END;
  IF before_state IS DISTINCT FROM jsonb_build_object(
    'league',(SELECT to_jsonb(l) FROM leagues l WHERE id=league),
    'season',(SELECT to_jsonb(s) FROM league_seasons s WHERE id=season),
    'matchups',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM matchups m WHERE league_season_id=season),
    'ties',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM rps_challenges r WHERE league_season_id=season)) THEN
    RAISE EXCEPTION 'Rejected legacy advancement or generation retry changed existing data';
  END IF;
  -- This synthetic fixture saved the exact original generated order above.
  -- This is a verified-evidence control, not an automatic legacy reconstruction.
  UPDATE league_seasons SET playoff_seed_member_ids=seeds[1:6] WHERE id=season AND playoff_seed_member_ids IS NULL;
  result:=advance_playoff_bracket_atomic(league);
  IF (result->>'inserted')::int<>2 THEN RAISE EXCEPTION 'Verified original seed snapshot did not permit progression'; END IF;
  SELECT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND matchup_type='playoff_semifinal' AND seeds[3] IN(home_member_id,away_member_id)) INTO restored;
  RAISE NOTICE 'actual eliminated_seed3_restored=%, original_bye_count=%',restored,(SELECT count(*) FROM matchups WHERE league_season_id=season AND matchup_type='playoff_semifinal' AND home_member_id IN(seeds[1],seeds[2]));
  IF restored OR (SELECT count(*) FROM matchups WHERE league_season_id=season AND matchup_type='playoff_semifinal' AND home_member_id IN(seeds[1],seeds[2]))<>2 THEN
    RAISE EXCEPTION 'Original seed control restored an eliminated team or removed a bye';
  END IF;
  -- Once actual semifinals exist, legacy progression needs only their winners.
  UPDATE league_seasons SET playoff_seed_member_ids=NULL WHERE id=season;
  UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id WHERE league_season_id=season AND matchup_type='playoff_semifinal';
  result:=advance_playoff_bracket_atomic(league);
  IF (result->>'inserted')::int<>1 OR NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season
    AND matchup_type='playoff_final' AND home_member_id=ANY(seeds[1:2]) AND away_member_id=ANY(seeds[1:2])) THEN
    RAISE EXCEPTION 'Unaffected legacy semifinal winners cannot reach the final';
  END IF;
  result:=advance_playoff_bracket_atomic(league);
  IF result->>'skipped'<>'true' THEN RAISE EXCEPTION 'Existing legacy final retry was not a no-op'; END IF;
END;
$$;
ROLLBACK;
