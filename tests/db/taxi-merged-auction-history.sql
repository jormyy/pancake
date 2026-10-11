-- Two actual auction sales collide when their provider identities merge.
BEGIN;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE
  scenario int; bidder int; users uuid[];
  members uuid[];
  players_ids uuid[];
  league uuid; season uuid; draft uuid; retained_roster jsonb; before_rosters jsonb; offer uuid; claim uuid; free_player uuid;
  nom nominations%ROWTYPE; i int; history jsonb; bid_history jsonb; transactions jsonb; budgets jsonb;
BEGIN
  FOR scenario IN 1..3 LOOP
  users:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  members:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  players_ids:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  league:=gen_random_uuid(); season:=gen_random_uuid();
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    VALUES(players_ids[i],'Synthetic','Auction duplicate '||i,'PG',ARRAY['PG'],0,i);
  END LOOP;
  INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,taxi_slots,auction_budget)
  VALUES(league,'Synthetic merged auction',league::text,users[1],'setup',20,2,100);
  INSERT INTO league_seasons(id,league_id,season_year,is_current)
  VALUES(season,league,2450+scenario,true);
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  VALUES(2450+scenario,1,(now() AT TIME ZONE 'America/New_York')::date-3,(now() AT TIME ZONE 'America/New_York')::date+3);
  FOR i IN 1..2 LOOP
    INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at)
    VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner'::league_member_role ELSE 'manager'::league_member_role END,
      'Synthetic team '||i,now()+make_interval(secs=>i));
  END LOOP;
  SELECT id INTO draft FROM start_auction_draft_atomic(league,'user_nominated',false,3600,100,'auction_no_bid');
  FOR i IN 1..2 LOOP
    nom:=create_auction_nomination_atomic(draft,members[i],players_ids[i],users[i],3600);
    bidder:=CASE WHEN scenario=1 THEN i ELSE 1 END;
    PERFORM place_auction_bid_atomic(draft,members[bidder],nom.id,i+1,users[bidder],scenario<>2 OR i=2);
    UPDATE nominations SET countdown_expires_at=now()-interval '1 second' WHERE id=nom.id;
    PERFORM close_auction_nomination_atomic(nom.id);
  END LOOP;
  IF (SELECT count(*) FROM nominations WHERE draft_id=draft AND status='sold')<>2 THEN
    RAISE EXCEPTION 'Both actual auction sales must complete';
  END IF;
  SELECT jsonb_agg(to_jsonb(n)-'player_id'-'merged_from_player_id' ORDER BY id) INTO history FROM nominations n WHERE draft_id=draft;
  SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) INTO bid_history FROM bids b JOIN nominations n ON n.id=b.nomination_id WHERE n.draft_id=draft;
  SELECT jsonb_agg(to_jsonb(t)-'player_id' ORDER BY id) INTO transactions FROM roster_transactions t WHERE league_id=league;
  SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) INTO budgets FROM draft_budgets b WHERE draft_id=draft;
  SELECT to_jsonb(r)-'player_id' INTO retained_roster FROM roster_players r
    WHERE league_id=league AND player_id=players_ids[CASE WHEN scenario=2 THEN 2 ELSE 1 END];
  IF scenario=2 THEN
    -- An accepted reservation must still reject the entire identity merge.
    offer:=gen_random_uuid(); claim:=gen_random_uuid(); free_player:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name) VALUES(free_player,'Synthetic','Free agent');
    BEGIN
    INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,accepted_at)
    VALUES(offer,league,season,members[1],members[2],'accepted',now());
    INSERT INTO trade_items(trade_id,league_id,side,player_id,from_member_id,to_member_id)
    VALUES(offer,league,'proposer',players_ids[1],members[1],members[2]);
    SELECT jsonb_agg(to_jsonb(r) ORDER BY id) INTO before_rosters FROM roster_players r WHERE league_id=league;
    BEGIN
      PERFORM merge_players(players_ids[1],players_ids[2]);
      RAISE EXCEPTION 'Merge bypassed an accepted trade reservation' USING ERRCODE='P9999';
    EXCEPTION WHEN SQLSTATE 'PA004' THEN NULL; END;
    IF before_rosters IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM roster_players r WHERE league_id=league)
       OR (SELECT count(*) FROM players WHERE id=ANY(players_ids))<>2
       OR EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=league) THEN
      RAISE EXCEPTION 'Rejected merge left partial identity, roster or exit changes';
    END IF;
    RAISE EXCEPTION 'accepted fixture rollback' USING ERRCODE='P9998';
    EXCEPTION WHEN SQLSTATE 'P9998' THEN NULL; END;
    INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(offer,league,season,members[1],members[2]);
    INSERT INTO trade_items(trade_id,league_id,side,player_id,from_member_id,to_member_id)
    VALUES(offer,league,'proposer',players_ids[1],members[1],members[2]);
    INSERT INTO trade_block_items(league_id,member_id,player_id) VALUES(league,members[1],players_ids[1]);
    INSERT INTO waiver_claims(id,league_id,league_season_id,member_id,player_id,drop_player_id,priority_at_submission,process_date)
    VALUES(claim,league,season,members[1],free_player,players_ids[1],1,current_date+2);
    INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type)
    VALUES(league,season,members[1],players_ids[1],(now() AT TIME ZONE 'America/New_York')::date-1,1,'PG'),
          (league,season,members[1],players_ids[1],(now() AT TIME ZONE 'America/New_York')::date+1,1,'PG');
  END IF;
  PERFORM merge_players(players_ids[1],players_ids[2]);
  IF retained_roster IS DISTINCT FROM (SELECT to_jsonb(r)-'player_id' FROM roster_players r WHERE league_id=league) THEN
    RAISE EXCEPTION 'Merge changed the retained taxi roster ID, owner, flags or acquisition data in scenario %',scenario;
  END IF;
  IF scenario=2 AND (
      (SELECT status FROM trades WHERE id=offer)<>'expired'
      OR EXISTS(SELECT 1 FROM trade_block_items WHERE league_id=league)
      OR (SELECT drop_player_id FROM waiver_claims WHERE id=claim) IS NOT NULL
      OR (SELECT count(*) FROM weekly_lineups WHERE league_id=league)<>1
      OR NOT EXISTS(SELECT 1 FROM weekly_lineups WHERE league_id=league AND game_date=(now() AT TIME ZONE 'America/New_York')::date-1)) THEN
    RAISE EXCEPTION 'Retained taxi merge did not clean active linked state while preserving locked history';
  END IF;
  IF history IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(n)-'player_id'-'merged_from_player_id' ORDER BY id) FROM nominations n WHERE draft_id=draft)
     OR bid_history IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM bids b JOIN nominations n ON n.id=b.nomination_id WHERE n.draft_id=draft)
     OR transactions IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t)-'player_id' ORDER BY id) FROM roster_transactions t WHERE league_id=league)
     OR budgets IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) FROM draft_budgets b WHERE draft_id=draft) THEN
    RAISE EXCEPTION 'Merge changed original nomination IDs, sale prices, winners, bids, transaction links or budgets';
  END IF;
  IF (SELECT count(*) FROM nominations WHERE draft_id=draft AND player_id=players_ids[1])<>2
     OR (SELECT count(*) FROM nominations WHERE draft_id=draft AND merged_from_player_id IS NULL)<>1 THEN
    RAISE EXCEPTION 'Merged sales must share the canonical player and retain one ordinary nomination guard';
  END IF;
  IF (scenario=1 AND NOT EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=league AND member_id=members[2] AND player_id=players_ids[1]))
     OR (scenario<>1 AND EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=league))
     OR EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=league AND member_id=members[1] AND player_id=players_ids[1]) THEN
    RAISE EXCEPTION 'Merged taxi exit belongs only to the team whose duplicate taxi row departs';
  END IF;
  BEGIN
    PERFORM create_auction_nomination_atomic(draft,members[1],players_ids[1],users[1],3600);
    RAISE EXCEPTION 'RPC allowed another nomination for the merged player' USING ERRCODE='P9999';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM<>'Player already nominated in this draft' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO nominations(draft_id,nominating_member_id,player_id,nomination_order,status)
    VALUES(draft,members[1],players_ids[1],3,'no_bid');
    RAISE EXCEPTION 'Database allowed another ordinary nomination' USING ERRCODE='P9999';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO nominations(draft_id,nominating_member_id,player_id,nomination_order,status,merged_from_player_id)
    VALUES(draft,members[1],players_ids[1],3,'no_bid',gen_random_uuid());
    RAISE EXCEPTION 'Client forged a merged nomination' USING ERRCODE='P9999';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'RESET ROLE';
  END LOOP;
END;
$$;
SELECT 'PASS: three actual-sale merge shapes preserve taxi/history, accepted reservation rollback and linked cleanup; repeated nomination permissions hold' AS result;
ROLLBACK;
