-- Canonical SQL source for public.get_trade_estimate_inputs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.build_trade_estimate_inputs(p_user_id,p_member_id,p_items,true);
$$;
