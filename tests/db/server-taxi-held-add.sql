\ir server-taxi-held-support.sql
DO $$
DECLARE f record; claim uuid; second uuid; outcome record;
BEGIN
  SELECT * INTO f FROM pg_temp.taxi_hold_fixture();
  PERFORM public.accept_trade_atomic(f.offer,f.member_ids[2]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[2]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L,false,true)',f.member_ids[2],f.league_id,f.other),'%Accepted trades hold 1 taxi slot%','taxi add names the slot held for an accepted trade');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=f.other),'rejected add owns no player');
  PERFORM set_config('request.jwt.claim.sub','',true);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 hour' WHERE id=f.offer;
  PERFORM public.complete_accepted_trade_atomic(f.offer);
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=f.offer),'the held taxi trade still settles');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
