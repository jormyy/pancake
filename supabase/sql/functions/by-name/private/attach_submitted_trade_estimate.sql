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
