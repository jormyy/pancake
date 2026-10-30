-- Canonical SQL source for public.save_trade_estimate_reanalysis.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.save_trade_estimate_reanalysis(p_trade_id uuid,p_inputs jsonb,p_analysis jsonb,p_run text DEFAULT 'onenumber-trade-curve-v6')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade public.trades%ROWTYPE; quote uuid; original jsonb; terms jsonb;
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id FOR UPDATE;
  SELECT quote_id INTO quote FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version=p_run;
  IF FOUND THEN RETURN quote; END IF;
  SELECT private.canonical_trade_estimate_terms(COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount)),'[]'::jsonb))
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  IF p_inputs->>'revaluationTradeId' IS DISTINCT FROM p_trade_id::text
    OR p_inputs->>'leagueId' IS DISTINCT FROM trade.league_id::text OR p_inputs->'terms' IS DISTINCT FROM terms
    OR jsonb_typeof(p_analysis->'teams') IS DISTINCT FROM 'array' OR jsonb_typeof(p_analysis->'assets') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Re-analysis must match the saved trade terms.' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object('estimate',to_jsonb(e),'quote',to_jsonb(q)) INTO original
    FROM public.trade_estimates e LEFT JOIN public.trade_estimate_quotes q ON q.id=e.quote_id WHERE e.trade_id=p_trade_id;
  INSERT INTO public.trade_estimate_history(trade_id,formula_version,quote_id,snapshot)
    SELECT p_trade_id,'original',e.quote_id,original FROM public.trade_estimates e WHERE e.trade_id=p_trade_id
    ON CONFLICT DO NOTHING;
  IF original IS NULL THEN
    INSERT INTO public.trade_estimate_history(trade_id,formula_version,snapshot) VALUES(p_trade_id,'original',jsonb_build_object('estimate',NULL,'quote',NULL)) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO public.trade_estimate_quotes(league_id,league_season_id,member_id,terms,inputs,analysis,model_version,input_version,expires_at)
    VALUES(trade.league_id,trade.league_season_id,trade.proposer_member_id,terms,p_inputs,p_analysis,'onenumber-trade-curve-v6',p_inputs->>'inputVersion',now()) RETURNING id INTO quote;
  INSERT INTO public.trade_estimate_history(trade_id,formula_version,quote_id,snapshot)
    SELECT p_trade_id,p_run,q.id,to_jsonb(q) FROM public.trade_estimate_quotes q WHERE q.id=quote;
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(p_trade_id,quote)
    ON CONFLICT(trade_id) DO UPDATE SET quote_id=EXCLUDED.quote_id,unavailable_reason=NULL,recorded_at=now();
  RETURN quote;
END;
$$;
