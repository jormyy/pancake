BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; offer uuid; request_id uuid:=gen_random_uuid(); payload jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9563);
  payload:=jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,
    'recipientMemberId',f.member_ids[2],'offerFaabAmount',1,'requestFaabAmount',2);
  offer:=public.submit_trade_offer_atomic(f.user_ids[1],request_id,f.member_ids[1],'propose',payload);
  PERFORM pg_temp.check_rules(offer=public.submit_trade_offer_atomic(f.user_ids[1],request_id,f.member_ids[1],'propose',payload),'the original request still replays');
  PERFORM pg_temp.reject_rules(format('SELECT public.submit_trade_offer_atomic(%L,%L,%L,%L,%L)',
    f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',payload||'{"notes":"A retry"}'),
    'An identical offer is already pending. Open that trade instead.','a new request cannot duplicate pending assets');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.trades WHERE league_id=f.league_id),'only one identical offer exists');
  PERFORM public.withdraw_trade_atomic(offer,f.member_ids[1],f.user_ids[1]);
  PERFORM pg_temp.check_rules(public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',payload)<>offer,
    'a withdrawn offer does not block a later proposal');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
