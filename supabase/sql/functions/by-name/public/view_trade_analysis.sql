CREATE OR REPLACE FUNCTION public.view_trade_analysis(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT public.view_trade_details(p_league_id, p_member_id, p_params || '{"includeRosterPreview":false}');
$$;
