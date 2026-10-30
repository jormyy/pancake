-- Canonical SQL source for private.retain_trade_estimate_quotes.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_trade_estimate_quotes(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.trade_estimate_quotes r
    WHERE r.expires_at<p_now-interval '7 days' AND NOT EXISTS (SELECT 1 FROM public.trade_estimates e WHERE e.quote_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.quote_id=r.id)
    ORDER BY r.expires_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.trade_estimate_quotes r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.trade_estimate_quotes',v_count);
END;
$$;
