BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); claim uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(1,9531);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,injury_status)
    VALUES(player,'Stored','IR','PG',ARRAY['PG'],'Out');
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,clears_at)
    VALUES(f.league_id,f.season_id,player,now()+interval '1 day');
  claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>player,
    p_user_id=>f.user_ids[1],p_to_ir=>true);
  PERFORM public.edit_waiver_claim_atomic(p_claim_id=>claim,p_member_id=>f.member_ids[1],p_user_id=>f.user_ids[1],
    p_bid_amount=>0);
  PERFORM pg_temp.check_rules((SELECT to_ir FROM waiver_claims WHERE id=claim),'omitted IR choice keeps stored value');
  PERFORM public.edit_waiver_claim_atomic(p_claim_id=>claim,p_member_id=>f.member_ids[1],p_user_id=>f.user_ids[1],
    p_bid_amount=>0,p_to_ir=>NULL);
  PERFORM pg_temp.check_rules((SELECT to_ir FROM waiver_claims WHERE id=claim),'null IR choice keeps stored value');
  PERFORM public.edit_waiver_claim_atomic(p_claim_id=>claim,p_member_id=>f.member_ids[1],p_user_id=>f.user_ids[1],
    p_bid_amount=>0,p_to_ir=>false);
  PERFORM pg_temp.check_rules((SELECT NOT to_ir FROM waiver_claims WHERE id=claim),'explicit false clears IR choice');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
