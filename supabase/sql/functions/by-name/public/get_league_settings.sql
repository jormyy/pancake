-- Canonical SQL source for public.get_league_settings.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_league_settings(p_league_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.league_members WHERE league_id=p_league_id AND user_id=auth.uid()) THEN
  RAISE EXCEPTION 'League settings are not available.' USING ERRCODE='42501';
 END IF;
 SELECT to_jsonb(l) INTO result FROM public.leagues l WHERE l.id=p_league_id AND l.deleted_at IS NULL;
 RETURN result;
END;
$$;
