BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='10s';
INSERT INTO private.work_kinds(kind,function_name) VALUES('trade-estimate','api/trades/estimate-work');

CREATE OR REPLACE FUNCTION private.attach_submitted_trade_estimate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade public.trades%ROWTYPE; terms jsonb;
BEGIN
  IF NOT NEW.inputs ? 'submittedTradeId' THEN RETURN NEW; END IF;
  SELECT * INTO STRICT trade FROM public.trades WHERE id=(NEW.inputs->>'submittedTradeId')::uuid;
  SELECT private.canonical_trade_estimate_terms(jsonb_agg(jsonb_build_object(
    'fromMemberId',item.from_member_id,'toMemberId',item.to_member_id,
    'playerId',item.player_id,'pickId',item.pick_id,'faabAmount',item.faab_amount)))
    INTO terms FROM public.trade_items item WHERE item.trade_id=trade.id;
  IF NEW.member_id<>trade.proposer_member_id OR NEW.league_id<>trade.league_id
    OR NEW.league_season_id<>trade.league_season_id OR NEW.terms IS DISTINCT FROM terms THEN
    RAISE EXCEPTION 'The estimate does not match the submitted trade.' USING ERRCODE='22023';
  END IF;
  UPDATE public.trade_estimates SET quote_id=NEW.id,unavailable_reason=NULL,recorded_at=NEW.created_at
    WHERE trade_id=trade.id AND quote_id IS NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.attach_trade_estimate(p_trade_id uuid,p_member_id uuid,p_quote_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE quote public.trade_estimate_quotes%ROWTYPE; trade public.trades%ROWTYPE; terms jsonb;
BEGIN
  IF p_quote_id IS NULL THEN
    INSERT INTO public.trade_estimates(trade_id,unavailable_reason) VALUES(p_trade_id,'The trade estimate is being prepared.');
    PERFORM private.work_enqueue('trade-estimate',p_trade_id::text,now(),jsonb_build_object('tradeId',p_trade_id));
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

REVOKE ALL ON FUNCTION private.attach_submitted_trade_estimate() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER attach_submitted_trade_estimate AFTER INSERT ON public.trade_estimate_quotes FOR EACH ROW EXECUTE FUNCTION private.attach_submitted_trade_estimate();
COMMIT;
