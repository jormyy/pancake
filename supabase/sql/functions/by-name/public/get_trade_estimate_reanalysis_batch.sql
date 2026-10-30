-- Canonical SQL source for public.get_trade_estimate_reanalysis_batch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_batch(p_run text DEFAULT 'onenumber-trade-curve-v6')
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id FROM public.trades t
  WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version=p_run)
  ORDER BY t.id LIMIT 25;
$$;
