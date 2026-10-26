CREATE OR REPLACE FUNCTION private.attach_trade_estimate(p_trade_id uuid,p_member_id uuid,p_quote_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE quote public.trade_estimate_quotes%ROWTYPE; trade public.trades%ROWTYPE; terms jsonb;
BEGIN
  IF p_quote_id IS NULL THEN
    INSERT INTO public.trade_estimates(trade_id,unavailable_reason) VALUES(p_trade_id,'No saved estimate was available when these terms were submitted.');
    RETURN;
  END IF;
  SELECT * INTO quote FROM public.trade_estimate_quotes WHERE id=p_quote_id;
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id;
  SELECT private.canonical_trade_estimate_terms(COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount)),'[]'::jsonb))
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  IF quote.id IS NULL OR quote.member_id<>p_member_id OR quote.league_id<>trade.league_id
    OR quote.league_season_id<>trade.league_season_id OR quote.terms IS DISTINCT FROM terms THEN
    RAISE EXCEPTION 'This estimate belongs to different trade terms. Review the current estimate and try again.' USING ERRCODE='22023';
  END IF;
  IF quote.expires_at<=now() THEN
    RAISE EXCEPTION 'This trade estimate has expired. Review an updated estimate and try again.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(p_trade_id,p_quote_id);
END;
$$;
