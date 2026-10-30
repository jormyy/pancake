-- Canonical SQL source for public.get_league_version.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_league_version(p_league_id uuid,p_user_id uuid,p_since text DEFAULT '0')
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE stored public.league_versions%ROWTYPE; changes jsonb; since_version bigint;
BEGIN
  IF p_since IS NULL OR p_since !~ '^(0|[1-9][0-9]{0,18})$' THEN RAISE EXCEPTION 'Invalid league version' USING ERRCODE='22023'; END IF;
  since_version := p_since::bigint;
  SELECT * INTO stored FROM public.league_versions WHERE league_id=p_league_id;
  IF NOT FOUND OR p_user_id IS NULL OR NOT (p_user_id=ANY(stored.reader_ids)) THEN
    RAISE EXCEPTION 'League not found' USING ERRCODE='42501';
  END IF;
  IF since_version>=stored.version THEN RETURN jsonb_build_object('version',stored.version::text,'changes','[]'::jsonb); END IF;
  IF since_version<stored.version-128 THEN
    changes := jsonb_build_array(jsonb_build_object('version',stored.version::text,'topic','catchup','scope','{}'::jsonb,'created_at',stored.updated_at));
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version::text,'topic',topic,'scope',scope,'created_at',created_at) ORDER BY version),'[]'::jsonb)
      INTO changes FROM public.league_changes WHERE league_id=p_league_id AND version>since_version AND version<=stored.version;
  END IF;
  RETURN jsonb_build_object('version',stored.version::text,'changes',changes);
END;
$$;
