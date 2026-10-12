-- Prepared from source. Not executed by the reviewer. Run as postgres in the isolated test database.
BEGIN;
DO $$
DECLARE
  users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  leagues_ids uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  seasons uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  picks uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  good uuid := gen_random_uuid(); bad uuid; rookie uuid := gen_random_uuid(); veteran uuid := gen_random_uuid();
  i int; a int; b int; err text;
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  FOR i IN 1..2 LOOP
    a:=i*2-1; b:=i*2;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,taxi_slots)
    VALUES(leagues_ids[i],'Taxi queue repro '||i,leagues_ids[i]::text,users[1],'active',1);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(seasons[i],leagues_ids[i],2152,true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[a],leagues_ids[i],users[1],'commissioner','A'),(members[b],leagues_ids[i],users[2],'manager','B');
  END LOOP;
  -- An unrelated, fully valid pick swap sorts ahead of the taxi trade.
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(picks[1],leagues_ids[1],2153,1,members[1],members[1]),(picks[2],leagues_ids[1],2153,1,members[2],members[2]);
  INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,accepted_at,veto_window_expires_at)
  VALUES(good,leagues_ids[1],seasons[1],members[1],members[2],'accepted',now()-interval '3 hours',now()-interval '2 hours');
  INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
  VALUES(good,members[1],0,true,now()),(good,members[2],1,false,now());
  INSERT INTO trade_items(trade_id,side,pick_id,from_member_id,to_member_id)
  VALUES(good,'proposer',picks[1],members[1],members[2]),(good,'recipient',picks[2],members[2],members[1]);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
  VALUES(rookie,'Taxi','Queue Rookie','PG',ARRAY['PG'],0,1),(veteran,'Taxi','Queue Veteran','PG',ARRAY['PG'],2,NULL);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(leagues_ids[2],seasons[2],members[3],rookie,'draft'),(leagues_ids[2],seasons[2],members[4],veteran,'draft');
  -- Use real proposal, receiver destination choice, and acceptance paths.
  bad := propose_trade_atomic(leagues_ids[2],seasons[2],members[3],members[4],ARRAY[rookie],ARRAY[veteran],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM set_trade_taxi_destinations_atomic(bad,members[4],ARRAY[rookie],users[2]);
  PERFORM accept_trade_atomic(bad,members[4]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 hour' WHERE id=bad;
  -- A normal season metadata refresh removes rookie eligibility during the veto wait.
  UPDATE players SET years_exp=1 WHERE id=rookie;
  BEGIN
    PERFORM process_due_accepted_trades_atomic(100);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN err := SQLERRM;
  END;
  IF err IS NOT NULL THEN
    IF err <> 'Only current rookies can be placed on the taxi squad.' THEN
      RAISE EXCEPTION 'Unexpected queue failure: %',err;
    END IF;
    IF (SELECT status FROM trades WHERE id=good)<>'accepted'
       OR (SELECT current_owner_id FROM draft_picks WHERE id=picks[1])<>members[1]
       OR (SELECT status FROM trades WHERE id=bad)<>'accepted' THEN
      RAISE EXCEPTION 'Queue failure has unexpected rollback state';
    END IF;
    RAISE EXCEPTION 'REPRODUCED: permanent taxi rejection aborts the due queue and rolls back an earlier valid trade';
  END IF;
  IF (SELECT status FROM trades WHERE id=good)<>'completed' THEN
    RAISE EXCEPTION 'The valid unrelated trade did not complete';
  END IF;
  IF (SELECT status FROM trades WHERE id=bad)<>'expired' THEN
    RAISE EXCEPTION 'The permanently invalid taxi trade did not expire';
  END IF;
END;
$$;
ROLLBACK;
