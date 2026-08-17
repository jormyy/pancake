-- Canonical SQL source for public.invoke_dynasty_ranking_views_at_et_time.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.

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
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_3"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"ROOKIE"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_5"}'::jsonb);
  END IF;
END;
$$;
