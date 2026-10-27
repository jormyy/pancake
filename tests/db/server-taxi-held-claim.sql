\ir server-taxi-held-support.sql
DO $$
DECLARE f record; claim uuid; second uuid; outcome record;
BEGIN
  SELECT * INTO f FROM pg_temp.taxi_hold_fixture();
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
    VALUES(f.league_id,f.season_id,f.claim_player,now()-interval '4 days');
  claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[2],p_player_id=>f.claim_player,p_drop_player_id=>NULL,p_user_id=>f.user_ids[2],p_to_taxi=>true);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  PERFORM public.accept_trade_atomic(f.offer,f.member_ids[2]);
  SELECT * INTO outcome FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(outcome.claim_id=claim AND outcome.status='succeeded','taxi claim succeeds when an accepted trade holds the last slot');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=f.claim_player AND NOT is_on_taxi),'taxi claim falls back to active while a slot is held');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 hour' WHERE id=f.offer;
  PERFORM public.complete_accepted_trade_atomic(f.offer);
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=f.offer),'claim fallback preserves settlement');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
