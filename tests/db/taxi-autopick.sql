-- Prepared from source. Not executed by the reviewer. Run as postgres in the isolated test database.
BEGIN;
DO $$
DECLARE
  u uuid := gen_random_uuid(); l uuid := gen_random_uuid(); m uuid := gen_random_uuid();
  s uuid := gen_random_uuid(); d uuid := gen_random_uuid(); asset uuid := gen_random_uuid();
  blocked uuid := gen_random_uuid(); eligible uuid := gen_random_uuid();
  err text; result jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(u,'authenticated','authenticated',u||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status,taxi_slots)
  VALUES(l,'Taxi auto-pick repro',l::text,u,'drafting',1);
  INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(m,l,u,'commissioner','A');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(s,l,2150,true);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
  VALUES(blocked,'Taxi','Blocked','PG',ARRAY['PG'],0,1),
        (eligible,'Taxi','Eligible','PG',ARRAY['PG'],0,2147483647);
  -- League-local historical bans isolate the pool without changing existing player metadata.
  INSERT INTO league_player_taxi_exits(league_id,player_id)
  SELECT l,id FROM players WHERE years_exp=0 AND nba_draft_number IS NOT NULL AND id<>eligible;
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(asset,l,2150,1,m,m);
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(d,l,s,'snake','in_progress',false,1);
  INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,draft_pick_id,timer_expires_at)
  VALUES(d,1,1,1,m,asset,now()+interval '10 minutes');
  IF NOT private.can_acquire_draft_taxi(l,s,m,eligible) THEN
    RAISE EXCEPTION 'Fixture has no valid taxi candidate';
  END IF;
  BEGIN
    result := auto_pick_snake_pick_atomic(d,m,'manual',true);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN err := SQLERRM;
  END;
  IF err IS NOT NULL THEN
    IF err <> 'This player has left taxi and cannot return, even after a trade or season change.' THEN
      RAISE EXCEPTION 'Unexpected auto-pick failure: %',err;
    END IF;
    -- The same on-clock slot succeeds through the real draft acquisition path.
    PERFORM make_snake_pick_atomic(d,m,eligible,true);
    IF NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=l AND player_id=eligible AND is_on_taxi) THEN
      RAISE EXCEPTION 'Control pick failed to acquire the eligible taxi player';
    END IF;
    RAISE EXCEPTION 'REPRODUCED: taxi auto-pick rejects a banned top rookie although a later taxi rookie is available';
  END IF;
  IF (result->>'player_id')::uuid <> eligible THEN
    RAISE EXCEPTION 'Auto-pick selected an unexpected taxi player: %',result;
  END IF;
END;
$$;
ROLLBACK;
