BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); roster uuid; offer uuid; code text; picks uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid()];
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9553,'offseason');
  UPDATE leagues SET taxi_slots=1 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    VALUES(player,'Offseason','Taxi','PG',ARRAY['PG'],1,64);
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],player,'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],player,true,'draft') RETURNING id INTO roster;
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(picks[1],f.league_id,9554,1,f.member_ids[1],f.member_ids[1]),(picks[2],f.league_id,9554,1,f.member_ids[2],f.member_ids[2]);
  UPDATE players SET career_regular_season_games=65 WHERE id=player;
  BEGIN offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],'offerPickIds',ARRAY[picks[1]],'requestPickIds',ARRAY[picks[2]])); EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  PERFORM pg_temp.check_rules(code='PT409','ineligible offseason taxi blocks an offer');
  PERFORM public.toggle_taxi_atomic(roster,false,f.user_ids[1]);
  PERFORM pg_temp.check_rules((SELECT NOT is_on_taxi FROM roster_players WHERE id=roster),'offseason taxi activation succeeds');
  offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],'offerPickIds',ARRAY[picks[1]],'requestPickIds',ARRAY[picks[2]]));
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=offer),'the same offseason offer succeeds after activation');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
