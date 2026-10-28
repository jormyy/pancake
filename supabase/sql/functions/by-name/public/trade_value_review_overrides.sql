CREATE OR REPLACE FUNCTION public.trade_value_review_overrides()
RETURNS TABLE(source_id text,resolved_player_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT source_id,resolved_player_id FROM public.trade_value_reviews WHERE resolved_player_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.trade_value_review_overrides() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trade_value_review_overrides() TO service_role;
