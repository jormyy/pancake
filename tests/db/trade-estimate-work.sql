BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; trade uuid; inputs jsonb; quote jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9562);
  trade:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',jsonb_build_object(
    'leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
    'offerFaabAmount',1,'requestFaabAmount',1));
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-estimate'
    AND payload->>'tradeId'=trade::text),'a committed offer has durable estimate work');
  PERFORM pg_temp.check_rules((SELECT quote_id IS NULL FROM public.trade_estimates WHERE trade_id=trade),'sending does not build an estimate');
  inputs:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)
    -ARRAY['revaluationTradeId','inputVersion','observedAt'];
  inputs:=inputs||jsonb_build_object('submittedTradeId',trade);
  quote:=public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],inputs,'{"teams":[],"assets":[]}','async-fixture');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.trade_estimates WHERE trade_id=trade AND quote_id=(quote->>'id')::uuid
    AND unavailable_reason IS NULL),'background work attaches its exact quote');
  PERFORM public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],inputs||'{"retry":true}',
    '{"teams":[],"assets":[]}','async-fixture');
  PERFORM pg_temp.check_rules((SELECT quote_id=(quote->>'id')::uuid FROM public.trade_estimates WHERE trade_id=trade),'a retry cannot replace a saved snapshot');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
