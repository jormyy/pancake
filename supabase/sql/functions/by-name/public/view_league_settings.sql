-- Canonical SQL source for public.view_league_settings.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_league_settings(p_league_id uuid,p_member_id uuid,p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
 SELECT public.view_settings(p_league_id,p_member_id,p_params);
$$;
