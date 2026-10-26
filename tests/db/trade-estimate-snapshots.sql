BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; terms jsonb; inputs jsonb; quote jsonb; second_quote jsonb; expected_analysis jsonb; payload jsonb; offer uuid; retried uuid; request_id uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9561);
  terms:=jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'faabAmount',10),
    jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[1],'faabAmount',20));
  inputs:=public.get_trade_estimate_inputs(f.user_ids[1],f.member_ids[1],terms);
  PERFORM pg_temp.check_rules((inputs->>'teams')::integer=3,'estimate uses actual league size');
  PERFORM pg_temp.check_rules((inputs->>'seasonYear')::integer=9561,'estimate uses active league season');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.save_trade_estimate_quote(uuid,uuid,jsonb,jsonb,text)','EXECUTE'),'clients cannot forge an estimate');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_estimate_inputs(%L,%L,%L)',f.user_ids[3],f.member_ids[1],terms),
    'Not authorized to estimate trades for this team.','another account cannot estimate as the sender');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_estimate_inputs(%L,%L,%L)',f.user_ids[1],f.member_ids[1],terms||terms),
    'Each trade asset must appear exactly once.','repeated assets are rejected');
  expected_analysis:=jsonb_build_object('teams',jsonb_build_array(jsonb_build_object('memberId',f.member_ids[1],'impact',9)),
    'assets',jsonb_build_array(jsonb_build_object('assetId','fixture')));
  quote:=public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],inputs,expected_analysis,'fixture-v1');
  second_quote:=public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],inputs,expected_analysis,'fixture-v1');
  PERFORM pg_temp.check_rules(quote->>'id'=second_quote->>'id','exact terms and inputs reuse a quote');
  second_quote:=public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],inputs||'{"rosterSize":99}'::jsonb,expected_analysis,'fixture-v1');
  PERFORM pg_temp.check_rules(quote->>'id'<>second_quote->>'id','changed relevant inputs create another quote');
  payload:=jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
    'offerFaabAmount',10,'requestFaabAmount',20,'estimateId',quote->>'id');
  offer:=public.submit_trade_offer_atomic(f.user_ids[1],request_id,f.member_ids[1],'propose',payload);
  PERFORM pg_temp.check_rules((SELECT quote_id::text=quote->>'id' FROM public.trade_estimates WHERE trade_id=offer),'submitted terms retain the exact displayed quote');
  retried:=public.submit_trade_offer_atomic(f.user_ids[1],request_id,f.member_ids[1],'propose',payload);
  PERFORM pg_temp.check_rules(offer=retried AND (SELECT count(*)=1 FROM public.trade_estimates WHERE trade_id=offer),'retry keeps one immutable estimate');
  PERFORM pg_temp.reject_rules(format('SELECT public.submit_trade_offer_atomic(%L,%L,%L,%L,%L)',
    f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',payload||'{"offerFaabAmount":11}'::jsonb),
    'This estimate belongs to different trade terms. Review the current estimate and try again.','old estimate cannot attach to new terms');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.trades WHERE league_id=f.league_id),'rejected quote leaves no partial offer');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[3]::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.trade_estimates WHERE trade_id=offer),'uninvolved manager cannot read a pending estimate');
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[2]::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.trade_estimate_quotes WHERE id=(quote->>'id')::uuid),'recipient reads the submitted quote');
  RESET ROLE;
  UPDATE public.trade_estimate_quotes SET expires_at=now()-interval '1 second' WHERE id=(quote->>'id')::uuid;
  PERFORM pg_temp.reject_rules(format('SELECT public.submit_trade_offer_atomic(%L,%L,%L,%L,%L)',
    f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',payload),
    'This trade estimate has expired. Review an updated estimate and try again.','expired quotes require a new review');
  PERFORM pg_temp.check_rules((SELECT q.analysis=expected_analysis FROM public.trade_estimate_quotes q JOIN public.trade_estimates s ON s.quote_id=q.id WHERE s.trade_id=offer),'source expiry never changes historical analysis');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
