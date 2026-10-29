BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_pick_window(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
DO $$
DECLARE
  users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  league uuid;
  season uuid;
  year int;
  next_id uuid;
  next_year int;
  created jsonb;
  member uuid;
  kept uuid[];
  added_years int[];
  i int;
  horizon int;
BEGIN
  FOR i IN 1..4 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  FOR horizon IN 3..5 BY 2 LOOP
  EXECUTE format('ALTER TABLE public.leagues ALTER COLUMN future_pick_years SET DEFAULT %s',horizon);
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  created := public.create_league(p_name=>'Pick window',p_team_name=>'Owner',p_auction_budget=>200);
  league := (created->>'id')::uuid;
  SELECT id,season_year INTO season,year FROM league_seasons WHERE league_id=league AND is_current;
  PERFORM pg_temp.assert_pick_window((SELECT count(*)=3*horizon AND min(season_year)=year+1 AND max(season_year)=year+horizon
    AND count(DISTINCT season_year)=horizon AND count(DISTINCT round)=3 FROM draft_picks WHERE league_id=league),format('create allocates %s future drafts',horizon));
  FOR i IN 2..4 LOOP
    PERFORM set_config('request.jwt.claim.sub',users[i]::text,true);
    PERFORM public.join_league_by_invite_code(p_invite_code=>created->>'invite_code',p_team_name=>'Team '||i);
  END LOOP;
  PERFORM pg_temp.assert_pick_window((SELECT count(*)=12*horizon AND count(DISTINCT current_owner_id)=4 AND max(season_year)=year+horizon
    FROM draft_picks WHERE league_id=league),format('join allocates %s future drafts per member',horizon));
  SELECT array_agg(id ORDER BY id) INTO kept FROM draft_picks WHERE league_id=league;
  PERFORM private.roll_setup_league_seasons(make_timestamptz(year,10,2,12,0,0,'America/New_York'));
  SELECT season_year INTO year FROM league_seasons WHERE id=season;
  PERFORM pg_temp.assert_pick_window((SELECT array_agg(id ORDER BY id)=kept AND count(*)=12*horizon AND min(season_year)=year+1 AND max(season_year)=year+horizon
    FROM draft_picks WHERE league_id=league),format('setup rollover preserves assets and %s future drafts',horizon));
  UPDATE leagues SET status='playoffs' WHERE id=league;
  PERFORM set_config('request.jwt.claim.sub','',true);
  SELECT new_season_id,new_year INTO next_id,next_year FROM public.advance_season_atomic(p_league_id=>league);
  SELECT array_agg(DISTINCT season_year ORDER BY season_year) INTO added_years FROM draft_picks WHERE league_id=league AND NOT id=ANY(kept);
  PERFORM pg_temp.assert_pick_window(added_years=ARRAY[next_year+horizon],'advance adds exactly one draft class');
  PERFORM pg_temp.assert_pick_window((SELECT count(*)=12*horizon AND count(DISTINCT season_year)=horizon AND max(season_year)=next_year+horizon
    FROM draft_picks WHERE league_id=league AND season_year>next_year),format('advance retains %s future drafts',horizon));
  PERFORM pg_temp.assert_pick_window((SELECT count(*)=12 FROM draft_picks WHERE league_id=league AND season_year=next_year AND NOT is_used),'advance retains current rookie draft assets');
  END LOOP;
END;
$$;
ROLLBACK;
