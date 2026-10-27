BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); roster uuid:=gen_random_uuid(); listing uuid; taxi uuid:=gen_random_uuid(); taxi_roster uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9582);
  UPDATE leagues SET allow_inactive_trades=true,taxi_slots=1 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,injury_status)
    VALUES(player,'Inactive','Listing','PG',ARRAY['PG'],'Out');
  INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
    VALUES(roster,f.league_id,f.season_id,f.member_ids[1],player,'waiver',true);
  listing:=public.add_trade_block_item_atomic(f.member_ids[1],f.league_id,player,NULL,'Keep this note',f.user_ids[1]);
  PERFORM pg_temp.check_rules(listing IS NOT NULL,'IR player can be listed when permitted');
  UPDATE roster_players SET is_on_ir=false WHERE id=roster;
  UPDATE roster_players SET is_on_ir=true WHERE id=roster;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM trade_block_items WHERE id=listing AND note='Keep this note'),'location changes preserve listing and note');
  PERFORM pg_temp.reject_rules(format('SELECT public.add_trade_block_item_atomic(%L,%L,%L,NULL,NULL,%L)',f.member_ids[2],f.league_id,player,f.user_ids[2]),'%own%','another team cannot list the player');
  UPDATE leagues SET allow_inactive_trades=false WHERE id=f.league_id;
  PERFORM pg_temp.reject_rules(format('SELECT public.add_trade_block_item_atomic(%L,%L,%L,NULL,NULL,%L)',f.member_ids[1],f.league_id,player,f.user_ids[1]),'%inactive%','inactive listing respects league permission');
  UPDATE leagues SET allow_inactive_trades=true,taxi_slots=1 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    VALUES(taxi,'Taxi','Listing','PG',ARRAY['PG'],0,0);
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],taxi,'draft',gen_random_uuid());
  INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
    VALUES(taxi_roster,f.league_id,f.season_id,f.member_ids[1],taxi,'draft',true);
  PERFORM public.add_trade_block_item_atomic(f.member_ids[1],f.league_id,taxi,NULL,'Taxi note',f.user_ids[1]);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM trade_block_items WHERE player_id=taxi),'taxi player can be listed');
  UPDATE roster_players SET is_on_taxi=false WHERE id=taxi_roster;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM trade_block_items WHERE player_id=taxi AND note='Taxi note'),'taxi promotion preserves listing');
  DELETE FROM roster_players WHERE id=roster;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM trade_block_items WHERE id=listing),'ownership loss removes listing');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
