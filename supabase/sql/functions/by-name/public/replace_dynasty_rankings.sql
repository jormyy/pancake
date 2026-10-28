CREATE OR REPLACE FUNCTION public.replace_dynasty_rankings(
  p_source text,p_fetched_at timestamptz,p_rows jsonb,p_min_rows integer DEFAULT 100,
  p_scoring_format text DEFAULT 'overall',p_source_url text DEFAULT NULL,p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('retired',true,'source','onenumberhoops.com');
$$;
REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text,timestamptz,jsonb,integer,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text,timestamptz,jsonb,integer,text,text,jsonb) TO service_role;
