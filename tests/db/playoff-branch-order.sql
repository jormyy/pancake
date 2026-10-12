BEGIN;
DO $$
DECLARE
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_user uuid;
  v_member uuid;
  v_seeds uuid[];
  v_reverse boolean;
  v_upset int;
  v_i int;
  v_away1 uuid;
  v_away2 uuid;
BEGIN
  FOR v_i IN 1..10 LOOP
    v_user := gen_random_uuid(); v_member := gen_random_uuid();
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now());
    IF v_i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week)
      VALUES(v_league,'Bracket Branches',v_league::text,v_user,'active',20);
      INSERT INTO league_seasons(id,league_id,season_year,is_current)
      VALUES(v_season,v_league,2110,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(v_member,v_league,v_user,CASE WHEN v_i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||v_i);
  END LOOP;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT 2110,w,'2110-02-01'::date+(w-20)*7,'2110-02-07'::date+(w-20)*7 FROM generate_series(20,22) w;
  SELECT array_agg(member_id ORDER BY seed_rank) INTO v_seeds FROM private.playoff_seed_rankings(v_league,v_season,20);
  FOREACH v_reverse IN ARRAY ARRAY[true,false] LOOP
    FOR v_upset IN 0..3 LOOP
      PERFORM generate_playoff_bracket_atomic(v_league);
      UPDATE matchups SET id=CASE
        WHEN (home_member_id=v_seeds[3]) = v_reverse THEN '00000000-0000-0000-0000-0000f6d46002'::uuid
        ELSE '00000000-0000-0000-0000-0000f6d46001'::uuid END,
        is_finalized=true,winner_member_id=CASE WHEN (home_member_id=v_seeds[3] AND (v_upset & 1)=1) OR (home_member_id=v_seeds[4] AND (v_upset & 2)=2) THEN away_member_id ELSE home_member_id END
      WHERE league_season_id=v_season AND matchup_type='playoff_quarterfinal';
      PERFORM advance_playoff_bracket_atomic(v_league);
      v_away1 := CASE WHEN (v_upset & 2)=2 THEN v_seeds[5] ELSE v_seeds[4] END;
      v_away2 := CASE WHEN (v_upset & 1)=1 THEN v_seeds[6] ELSE v_seeds[3] END;
      IF NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=v_season AND matchup_type='playoff_semifinal' AND home_member_id=v_seeds[1] AND away_member_id=v_away1)
         OR NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=v_season AND matchup_type='playoff_semifinal' AND home_member_id=v_seeds[2] AND away_member_id=v_away2) THEN
        RAISE EXCEPTION 'Semifinal branches changed with row IDs (reverse %, upset %)',v_reverse,v_upset;
      END IF;
      BEGIN
        PERFORM advance_playoff_bracket_atomic(v_league);
        RAISE EXCEPTION 'Unfinished semifinals advanced';
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'Semifinals are not yet finalized.' THEN RAISE; END IF;
      END;
      DELETE FROM matchups WHERE league_season_id=v_season AND matchup_type='playoff_semifinal';
      DELETE FROM matchups WHERE league_season_id=v_season;
    END LOOP;
  END LOOP;
END;
$$;
ROLLBACK;
