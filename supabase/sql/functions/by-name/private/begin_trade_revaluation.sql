CREATE OR REPLACE FUNCTION private.begin_trade_revaluation(p_trade_id uuid,p_model text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE live boolean; allowed boolean;
BEGIN
  IF p_model IS NULL OR NOT EXISTS(SELECT 1 FROM public.trades WHERE id=p_trade_id AND status IN ('pending','accepted')) THEN RETURN false; END IF;
  live:=private.trade_revaluation_is_live(p_trade_id);
  INSERT INTO private.trade_revaluation_schedule AS schedule(trade_id,model_version,next_allowed_at)
    VALUES(p_trade_id,p_model,now()+CASE WHEN live THEN interval '10 minutes' ELSE interval '0' END)
    ON CONFLICT(trade_id) DO UPDATE SET next_allowed_at=EXCLUDED.next_allowed_at,model_version=EXCLUDED.model_version
    WHERE NOT live OR schedule.next_allowed_at<=now() RETURNING true INTO allowed;
  RETURN COALESCE(allowed,false);
END;
$$;
REVOKE ALL ON FUNCTION private.begin_trade_revaluation(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
