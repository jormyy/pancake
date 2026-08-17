-- Make Hashtag's points-league rankings the canonical dynasty source.

-- Canonical SQL source: supabase/sql/functions/by-name/public/invoke_dynasty_ranking_views_at_et_time.sql

CREATE OR REPLACE FUNCTION public.invoke_dynasty_ranking_views_at_et_time(
  p_hour int,
  p_minute int DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp;
BEGIN
  v_now := timezone('America/New_York', now());
  IF EXTRACT(HOUR FROM v_now)::int = p_hour
     AND EXTRACT(MINUTE FROM v_now)::int = p_minute THEN
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"CONTEND"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"REBUILD"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"ROOKIE"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT"}'::jsonb);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(int, int) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(int, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(int, int) TO service_role;
