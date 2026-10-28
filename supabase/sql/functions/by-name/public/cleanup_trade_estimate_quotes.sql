CREATE OR REPLACE FUNCTION public.cleanup_trade_estimate_quotes()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE removed integer;
BEGIN
  WITH expired AS (
    SELECT q.id FROM public.trade_estimate_quotes q WHERE q.expires_at<now()-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM public.trade_estimates e WHERE e.quote_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.quote_id=q.id)
    ORDER BY q.expires_at,q.id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.trade_estimate_quotes q USING expired WHERE q.id=expired.id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;
