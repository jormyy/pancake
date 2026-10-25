BEGIN;
\ir rules-support.sql
CREATE FUNCTION pg_temp.taxi_hold_fixture()
RETURNS TABLE(league_id uuid,season_id uuid,user_ids uuid[],member_ids uuid[],incoming uuid,other uuid,claim_player uuid,offer uuid)
LANGUAGE plpgsql AS $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9554);
  league_id:=f.league_id; season_id:=f.season_id; user_ids:=f.user_ids; member_ids:=f.member_ids;
  incoming:=gen_random_uuid(); other:=gen_random_uuid(); claim_player:=gen_random_uuid();
  UPDATE leagues SET taxi_slots=1,trade_veto_mode='member_vote',trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    VALUES(incoming,'Incoming','Taxi','PG',ARRAY['PG'],1,64),(other,'Other','Taxi','PG',ARRAY['PG'],1,64),(claim_player,'Claim','Taxi','PG',ARRAY['PG'],1,64);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],incoming,'draft');
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    SELECT f.league_id,9555,n,f.member_ids[2],f.member_ids[2] FROM generate_series(1,2) n;
  offer:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[incoming],'{}','{}',ARRAY[(SELECT dp.id FROM draft_picks dp WHERE dp.league_id=f.league_id AND dp.round=1)]);
  PERFORM public.set_trade_taxi_destinations_atomic(offer,f.member_ids[2],ARRAY[incoming],f.user_ids[2]);
  RETURN NEXT;
END;
$$;
