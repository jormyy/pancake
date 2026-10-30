-- Run as postgres in an isolated test database loaded with production-shaped players.
BEGIN;
DO $$
DECLARE
  u uuid := gen_random_uuid(); l uuid := gen_random_uuid(); m uuid := gen_random_uuid();
  s uuid := gen_random_uuid(); d uuid := gen_random_uuid(); veteran uuid := gen_random_uuid();
  rookie uuid := gen_random_uuid(); nom nominations%ROWTYPE; err text;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(u,'authenticated','authenticated',u||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,taxi_slots)
  VALUES(l,'Taxi auction pool repro',l::text,u,'drafting',1,1);
  INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(m,l,u,'commissioner','A');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(s,l,2151,true);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
  VALUES(veteran,'Taxi','Veteran','PG',ARRAY['PG'],2,NULL),(rookie,'Taxi','Unsold','PG',ARRAY['PG'],0,1);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(l,s,m,veteran,'draft');
  -- Every other Taxi-eligible player has a team-local historical exit. Only the unsold rookie can fill taxi.
  INSERT INTO league_member_taxi_exits(league_id,member_id,player_id)
  SELECT l,m,id FROM players WHERE private.taxi_player_eligible(l,id) AND id<>rookie;
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(d,l,s,'auction','in_progress',false,1);
  INSERT INTO draft_orders(draft_id,member_id,position) VALUES(d,m,1);
  INSERT INTO draft_budgets(draft_id,member_id,initial_budget,remaining) VALUES(d,m,10,10);
  nom := create_auction_nomination_atomic(d,m,rookie,u,5);
  UPDATE nominations SET countdown_expires_at=now()-interval '1 second' WHERE id=nom.id;
  IF NOT close_auction_nomination_atomic(nom.id) THEN RAISE EXCEPTION 'Fixture nomination did not close'; END IF;
  IF (SELECT status FROM nominations WHERE id=nom.id)<>'no_bid' THEN
    RAISE EXCEPTION 'Fixture nomination is not no_bid';
  END IF;
  IF (SELECT status FROM drafts WHERE id=d)='in_progress' THEN
    IF NOT private.can_acquire_draft_taxi(l,s,m) THEN
      RAISE EXCEPTION 'Unexpected incomplete auction with no taxi pool';
    END IF;
    BEGIN
      PERFORM create_auction_nomination_atomic(d,m,rookie,u,5);
    EXCEPTION WHEN OTHERS THEN err := SQLERRM;
    END;
    IF err IS DISTINCT FROM 'Player already nominated in this draft' THEN
      RAISE EXCEPTION 'Unexpected renomination result: %',err;
    END IF;
    RAISE EXCEPTION 'REPRODUCED: auction remains in progress because its taxi pool counts an unsold rookie it cannot nominate again';
  END IF;
  IF (SELECT status FROM drafts WHERE id=d)<>'completed' THEN
    RAISE EXCEPTION 'Auction has an unexpected terminal status';
  END IF;
END;
$$;
ROLLBACK;
