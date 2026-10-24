BEGIN;
DO $$
DECLARE
  league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); users uuid[]:='{}'; members uuid[]:='{}'; i int; ranked uuid[];
BEGIN
  FOR i IN 1..4 LOOP
    users:=array_append(users,gen_random_uuid()); members:=array_append(members,gen_random_uuid());
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'Synthetic seed priority',league::text,users[1],'active');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8613,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i);
  END LOOP;
  INSERT INTO matchups(league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id,home_points,away_points,home_max_possible_points,away_max_possible_points,winner_member_id,is_finalized)
  VALUES(league,season,1,'regular_season',members[1],members[4],100,10,101,10,members[1],true),
    (league,season,1,'regular_season',members[2],members[3],100,20,102,20,members[2],true);
  SELECT array_agg(member_id ORDER BY seed_rank) INTO ranked FROM private.playoff_seed_rankings(league,season,2);
  IF ranked[1:2]<>ARRAY[members[2],members[1]] THEN RAISE EXCEPTION 'Max possible points breaks equal wins and points first'; END IF;
  UPDATE matchups SET home_max_possible_points=101 WHERE league_season_id=season;
  SELECT array_agg(member_id ORDER BY seed_rank) INTO ranked FROM private.playoff_seed_rankings(league,season,2);
  IF ranked[1:2]<>ARRAY[members[1],members[2]] THEN RAISE EXCEPTION 'Lower points against breaks equal wins, points and max'; END IF;
  RAISE NOTICE 'PASS: seed priority uses max points before lower points against';
END;
$$;
ROLLBACK;
