-- Canonical SQL source for private.begin_trade_revaluation.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.begin_trade_revaluation(p_trade_id uuid,p_model text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_model IS NULL OR NOT EXISTS(SELECT 1 FROM public.trades WHERE id=p_trade_id AND status IN ('pending','accepted')) THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM private.trade_revaluation_schedule WHERE trade_id=p_trade_id AND next_allowed_at>now());
END;
$$;
