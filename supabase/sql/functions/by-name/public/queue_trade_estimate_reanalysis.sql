-- Canonical SQL source for public.queue_trade_estimate_reanalysis.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.queue_trade_estimate_reanalysis(p_run text DEFAULT 'onenumber-trade-curve-v5')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE remaining bigint; completed bigint;
BEGIN
  SELECT count(*) INTO remaining FROM public.trades t WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version=p_run);
  IF remaining=0 THEN RETURN 0; END IF;
  SELECT count(*) INTO completed FROM public.trade_estimate_history WHERE formula_version=p_run;
  PERFORM private.work_enqueue('trade-estimate','reanalysis:'||p_run||':'||completed::text,now(),
    jsonb_build_object('reanalysisVersion','onenumber-trade-curve-v5','completed',completed,'runVersion',p_run));
  RETURN remaining;
END;
$$;
