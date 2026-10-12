-- A trade into the receiver's taxi that settles while the player's game is in progress is delayed, not expired:
-- the queue reports it deferred, the trade stays accepted, and it settles into taxi once the slate ends. With veto
-- disabled, acceptance itself succeeds during the game and leaves settlement to the queue.
BEGIN;
DO $$
DECLARE
  users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  leagues_ids uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  seasons uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  rookies uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  veterans uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_trade uuid; v_instant uuid; v_game uuid := gen_random_uuid(); v_status text; i int; a int; b int;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  FOR i IN 1..2 LOOP
    a:=i*2-1; b:=i*2;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,taxi_slots,trade_veto_mode)
    VALUES(leagues_ids[i],'Taxi game lock '||i,leagues_ids[i]::text,users[1],'active',1,CASE WHEN i=2 THEN 'disabled' ELSE 'member_vote' END);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(seasons[i],leagues_ids[i],2162,true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[a],leagues_ids[i],users[1],'commissioner','A'),(members[b],leagues_ids[i],users[2],'manager','B');
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number,nba_team)
    VALUES(rookies[i],'Lock','Rookie '||i,'PG',ARRAY['PG'],0,i,'ZGL'),(veterans[i],'Lock','Veteran '||i,'PG',ARRAY['PG'],3,NULL,'ZGV');
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(leagues_ids[i],seasons[i],members[a],rookies[i],'draft'),(leagues_ids[i],seasons[i],members[b],veterans[i],'draft');
  END LOOP;
  -- Both receivers choose taxi before tip-off; the first trade is accepted into its veto window.
  v_trade := propose_trade_atomic(leagues_ids[1],seasons[1],members[1],members[2],ARRAY[rookies[1]],ARRAY[veterans[1]],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM set_trade_taxi_destinations_atomic(v_trade,members[2],ARRAY[rookies[1]],users[2]);
  PERFORM accept_trade_atomic(v_trade,members[2]);
  v_instant := propose_trade_atomic(leagues_ids[2],seasons[2],members[3],members[4],ARRAY[rookies[2]],ARRAY[veterans[2]],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM set_trade_taxi_destinations_atomic(v_instant,members[4],ARRAY[rookies[2]],users[2]);

  -- The rookies' team tips off.
  INSERT INTO nba_games(id,season_year,week_number,game_date,home_team,away_team,status,nba_game_id,game_time)
  VALUES(v_game,2162,1,v_today,'ZGL','ZGX','InProgress','0099162001',now()-interval '1 hour');

  -- Queue path: the veto window ends while the game is on.
  UPDATE trades SET veto_window_expires_at=now()-interval '1 hour' WHERE id=v_trade;
  SELECT r.status INTO v_status FROM process_due_accepted_trades_atomic(100) r WHERE r.trade_id=v_trade;
  IF (SELECT status FROM trades WHERE id=v_trade)='expired' THEN
    RAISE EXCEPTION 'REPRODUCED: a temporary game lock permanently expired a trade into taxi';
  END IF;
  IF v_status IS DISTINCT FROM 'deferred' OR (SELECT status FROM trades WHERE id=v_trade)<>'accepted'
     OR NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=leagues_ids[1] AND player_id=rookies[1] AND member_id=members[1]) THEN
    RAISE EXCEPTION 'Game-locked taxi trade was not deferred intact (status %)', v_status;
  END IF;

  -- Immediate path: veto disabled, so acceptance during the game settles at once unless the game defers it.
  PERFORM accept_trade_atomic(v_instant,members[4]);
  IF (SELECT status FROM trades WHERE id=v_instant)<>'accepted' THEN
    RAISE EXCEPTION 'Immediate acceptance during the game did not leave the trade accepted';
  END IF;

  -- The slate ends: both trades settle into the receivers' taxi squads.
  DELETE FROM nba_games WHERE id=v_game;
  UPDATE trades SET veto_window_expires_at=now()-interval '1 hour' WHERE id IN (v_trade,v_instant) AND veto_window_expires_at > now();
  PERFORM process_due_accepted_trades_atomic(100);
  IF (SELECT status FROM trades WHERE id=v_trade)<>'completed' OR (SELECT status FROM trades WHERE id=v_instant)<>'completed' THEN
    RAISE EXCEPTION 'Deferred taxi trades did not settle after the game (% / %)',
      (SELECT status FROM trades WHERE id=v_trade),(SELECT status FROM trades WHERE id=v_instant);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=leagues_ids[1] AND player_id=rookies[1] AND member_id=members[2] AND is_on_taxi)
     OR NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=leagues_ids[2] AND player_id=rookies[2] AND member_id=members[4] AND is_on_taxi) THEN
    RAISE EXCEPTION 'Settled trades did not place the rookies on the receivers'' taxi squads';
  END IF;
END;
$$;
ROLLBACK;
