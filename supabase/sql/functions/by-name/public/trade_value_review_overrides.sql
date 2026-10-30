-- Canonical SQL source for public.trade_value_review_overrides.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.trade_value_review_overrides()
RETURNS TABLE(source_id text,resolved_player_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT source_id,resolved_player_id FROM public.trade_value_reviews WHERE resolved_player_id IS NOT NULL;
$$;
