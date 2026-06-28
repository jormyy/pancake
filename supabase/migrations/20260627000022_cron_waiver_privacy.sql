-- Cron wrapper and waiver-log privacy hardening:
-- - lock the ET cron Edge wrapper away from client roles
-- - hide expired uncleared waiver logs without reintroducing add-RPC branching

REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) TO service_role;

DROP POLICY IF EXISTS "waiver_wire_log_select_visible_league_rows" ON public.waiver_wire_log;
DROP POLICY IF EXISTS "waiver_wire_log_select" ON public.waiver_wire_log;

CREATE POLICY "waiver_wire_log_select_visible_league_rows" ON public.waiver_wire_log
  FOR SELECT TO authenticated
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND (
      cleared_at IS NOT NULL
      OR clears_at > now()
    )
  );
