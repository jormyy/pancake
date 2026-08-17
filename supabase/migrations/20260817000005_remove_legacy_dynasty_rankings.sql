-- Remove the hidden compatibility layer after the forecast-view release is live.

DROP FUNCTION IF EXISTS public.get_dynasty_decision_inputs(uuid, uuid, int, uuid[], text, int, int);

DELETE FROM public.dynasty_rankings
 WHERE source IN (
   'hashtagbasketball.com/contend',
   'hashtagbasketball.com/rebuild'
 );

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
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_3"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"ROOKIE"}'::jsonb);
    PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_5"}'::jsonb);
  END IF;
END;
$$;

ANALYZE public.dynasty_rankings;
