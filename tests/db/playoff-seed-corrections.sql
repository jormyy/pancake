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
