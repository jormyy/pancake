\ir server-taxi-held-support.sql
DO $$
DECLARE f record; claim uuid; second uuid; outcome record;
BEGIN
  SELECT * INTO f FROM pg_temp.taxi_hold_fixture();
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[2],f.other,'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],f.other,true,'draft');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',f.offer,f.member_ids[2]),'%taxi is % over the limit%','accept rechecks the recipients full taxi');
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=f.offer),'full taxi leaves the offer pending');
  DELETE FROM roster_players WHERE league_id=f.league_id AND player_id=f.other;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[3],f.claim_player,'draft');
  second:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[3],f.member_ids[2],ARRAY[f.claim_player],'{}','{}',ARRAY[(SELECT id FROM draft_picks WHERE league_id=f.league_id AND round=2)]);
  PERFORM public.set_trade_taxi_destinations_atomic(second,f.member_ids[2],ARRAY[f.claim_player],f.user_ids[2]);
  PERFORM public.accept_trade_atomic(f.offer,f.member_ids[2]);
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',second,f.member_ids[2]),'%accepted trades reserve%','accept counts another accepted trades held taxi slot');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
