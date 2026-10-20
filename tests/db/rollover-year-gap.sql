BEGIN;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE
  usr uuid; league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); member uuid;
  next_year int; next_id uuid; i int; result jsonb;
BEGIN
  FOR i IN 1..4 LOOP
    usr:=gen_random_uuid(); member:=gen_random_uuid();
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(usr,'authenticated','authenticated',usr||'@example.test','x',now(),'{}','{}',now(),now());
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'Synthetic skipped years',league::text,usr,'playoffs');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,2000,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(member,league,usr,CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i);
    INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    SELECT league,y,r,member,member FROM generate_series(2001,2005) y CROSS JOIN generate_series(1,3) r;
  END LOOP;
  SELECT new_season_id,new_year INTO next_id,next_year FROM advance_season_atomic(league);
  result:=start_rookie_draft_atomic(league,3,false);
  IF (SELECT count(*) FROM snake_draft_picks WHERE draft_id=(result->>'id')::uuid)<>12 THEN
    RAISE EXCEPTION 'Year jump must allocate every current rookie slot';
  END IF;
  IF (SELECT count(*) FROM draft_picks WHERE league_id=league AND season_year BETWEEN next_year AND next_year+5)<>72 THEN
    RAISE EXCEPTION 'Year jump must restore all six pick years';
  END IF;
  IF (SELECT count(*) FROM draft_picks WHERE league_id=league AND season_year BETWEEN 2001 AND 2005)<>60 THEN
    RAISE EXCEPTION 'Year jump changed historical picks';
  END IF;
  RAISE NOTICE 'PASS: skipped-year rollover preserves history and fills the current and future pick years';
END;
$$;
ROLLBACK;
