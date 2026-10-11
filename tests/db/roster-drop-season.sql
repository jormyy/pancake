BEGIN;
DO $$
DECLARE
  v_user uuid := gen_random_uuid(); v_other uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid(); v_member uuid := gen_random_uuid();
  v_old uuid := gen_random_uuid(); v_current uuid := gen_random_uuid();
  v_player uuid := gen_random_uuid(); v_row uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
  VALUES(v_league,'Expected season drop',v_league::text,v_user,'active');
  INSERT INTO league_members(id,league_id,user_id,role,team_name)
  VALUES(v_member,v_league,v_user,'commissioner','Team');
  INSERT INTO league_seasons(id,league_id,season_year,is_current)
  VALUES(v_old,v_league,2208,false),(v_current,v_league,2209,true);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp)
  VALUES(v_player,'Drop','Player','PG',ARRAY['PG'],0);
  INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(v_row,v_league,v_current,v_member,v_player,'carry_over');
  PERFORM set_config('request.jwt.claim.sub',v_user::text,true);
  BEGIN
    PERFORM drop_player_atomic(v_row,v_old);
    RAISE EXCEPTION 'Historical context drops current roster';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'The roster season has changed. Refresh before dropping a player.' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub',v_other::text,true);
  BEGIN
    PERFORM drop_player_atomic(v_row,v_current);
    RAISE EXCEPTION 'Another user drops owned roster';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  IF NOT EXISTS(SELECT 1 FROM roster_players WHERE id=v_row)
     OR EXISTS(SELECT 1 FROM waiver_wire_log WHERE league_id=v_league)
     OR EXISTS(SELECT 1 FROM roster_transactions WHERE league_id=v_league) THEN
    RAISE EXCEPTION 'Denied drop changes persistence';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',v_user::text,true);
  PERFORM drop_player_atomic(v_row,v_current);
  IF EXISTS(SELECT 1 FROM roster_players WHERE id=v_row)
     OR (SELECT count(*) FROM waiver_wire_log WHERE league_id=v_league) <> 1
     OR (SELECT count(*) FROM roster_transactions WHERE league_id=v_league AND transaction_type='fa_drop') <> 1 THEN
    RAISE EXCEPTION 'Bound current drop must persist roster, waiver and transaction atomically';
  END IF;
  INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(v_row,v_league,v_current,v_member,v_player,'carry_over');
  PERFORM drop_player_atomic(v_row);
  IF EXISTS(SELECT 1 FROM roster_players WHERE id=v_row) THEN RAISE EXCEPTION 'Ordinary drop regresses'; END IF;
  IF has_function_privilege('anon','public.drop_player_atomic(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.drop_player_atomic(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Bound drop permissions are incorrect';
  END IF;
END;
$$;
ROLLBACK;
