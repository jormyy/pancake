CREATE OR REPLACE FUNCTION public.view_league_settings(p_league_id uuid,p_member_id uuid,p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
 SELECT public.view_settings(p_league_id,p_member_id,p_params);
$$;
