BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.check_deadline(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
CREATE FUNCTION pg_temp.reject_deadline(command text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_deadline(message LIKE '%Trades are locked%',label||COALESCE(': '||message,': unexpected success'));
END;
$$;
DO $$
DECLARE
  league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); users uuid[]:='{}'; members uuid[]:='{}';
  today date:=(now() AT TIME ZONE 'America/New_York')::date; offer uuid; expired_offer uuid;
  future_offer uuid; no_expiry uuid; asset uuid; other_asset uuid; i int; message text; result_count int; batch_count int;
BEGIN
  PERFORM pg_temp.check_deadline(private.trade_deadline_for_season('2000-10-01',3102)='3101-10-01','October deadline anchors in previous year');
  FOR i IN 1..4 LOOP
    users:=array_append(users,gen_random_uuid()); members:=array_append(members,gen_random_uuid());
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status,trade_deadline) VALUES(league,'Synthetic deadline',league::text,users[1],'active',today);
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8612,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i);
  END LOOP;
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(league,8613,1,members[1],members[1]) RETURNING id INTO asset;
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(league,8613,1,members[2],members[2]) RETURNING id INTO other_asset;
  offer:=propose_trade_atomic(league,season,members[1],members[2],'{}','{}',ARRAY[asset],ARRAY[other_asset]);
  PERFORM pg_temp.check_deadline(offer IS NOT NULL,'offer creation stays open on the deadline ET date');
  UPDATE trades SET status='accepted' WHERE id=offer;
  PERFORM pg_temp.check_deadline((SELECT status='accepted' FROM trades WHERE id=offer),'acceptance stays open on the deadline ET date');
  UPDATE trades SET status='pending' WHERE id=offer;
  UPDATE leagues SET trade_deadline=today-1 WHERE id=league;
  PERFORM pg_temp.reject_deadline(format('UPDATE trades SET status=''accepted'' WHERE id=%L',offer),'acceptance locks the next ET date');
  PERFORM pg_temp.reject_deadline(format('SELECT propose_trade_atomic(%L,%L,%L,%L,ARRAY[]::uuid[],ARRAY[]::uuid[],%L,%L)',league,season,members[1],members[2],ARRAY[asset]::text,ARRAY[other_asset]::text),'new offers lock the next ET date');
  UPDATE leagues SET status='playoffs' WHERE id=league;
  PERFORM pg_temp.reject_deadline(format('UPDATE trades SET status=''accepted'' WHERE id=%L',offer),'playoff acceptance stays locked before champion');
  INSERT INTO matchups(league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id,is_finalized,winner_member_id)
  VALUES(league,season,1,'playoff_final',members[1],members[2],true,members[1]);
  UPDATE trades SET status='accepted' WHERE id=offer;
  PERFORM pg_temp.check_deadline((SELECT status='accepted' FROM trades WHERE id=offer),'champion reopens acceptance');
  UPDATE trades SET status='withdrawn' WHERE id=offer;
  offer:=propose_trade_atomic(league,season,members[1],members[2],'{}','{}',ARRAY[asset],ARRAY[other_asset]);
  PERFORM pg_temp.check_deadline(offer IS NOT NULL,'champion reopens offer creation');
  UPDATE trades SET status='withdrawn' WHERE id=offer;
  UPDATE leagues SET status='active',trade_deadline=today+1 WHERE id=league;
  BEGIN
    PERFORM private.create_trade_offer(league,season,members[1],members[2],'{}','{}',ARRAY[asset],ARRAY[other_asset],NULL,(today+3)::timestamp AT TIME ZONE 'America/New_York');
  EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_deadline(message LIKE '%before the trade deadline%','expiration cannot cross the deadline');
  offer:=private.create_trade_offer(league,season,members[1],members[2],'{}','{}',ARRAY[asset],ARRAY[other_asset],NULL,(today+1)::timestamp AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_deadline(offer IS NOT NULL,'expiration on the deadline is accepted');
  UPDATE trades SET status='withdrawn' WHERE id=offer;
  expired_offer:=gen_random_uuid(); future_offer:=gen_random_uuid(); no_expiry:=gen_random_uuid();
  INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,expires_at)
  VALUES(expired_offer,league,season,members[1],members[2],now()),
    (future_offer,league,season,members[1],members[2],now()+interval '1 day'),
    (no_expiry,league,season,members[1],members[2],NULL);
  LOOP
    SELECT count(*),count(*) FILTER(WHERE expired.trade_id=expired_offer) INTO batch_count,result_count
    FROM expire_pending_trades_atomic(100) expired;
    EXIT WHEN result_count>0 OR batch_count=0;
  END LOOP;
  PERFORM pg_temp.check_deadline(result_count=1 AND (SELECT status='expired' FROM trades WHERE id=expired_offer)
    AND (SELECT status='pending' FROM trades WHERE id=future_offer) AND (SELECT status='pending' FROM trades WHERE id=no_expiry),'expiry resolves due offers and preserves future and indefinite offers');
  UPDATE leagues SET trade_deadline=today-1 WHERE id=league;
  PERFORM expire_pending_trades_atomic(100);
  PERFORM pg_temp.check_deadline((SELECT status='pending' FROM trades WHERE id=no_expiry),'deadline locks but does not expire indefinite pending offers');
END;
$$;
ROLLBACK;
