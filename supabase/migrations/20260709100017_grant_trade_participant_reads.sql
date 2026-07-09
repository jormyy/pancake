-- Trade list queries embed participant routing. RLS remains the row-level boundary.
GRANT SELECT ON public.trade_participants TO authenticated;
REVOKE SELECT ON public.trade_participants FROM anon;

-- Acceptance is authorized by the API before the service client reaches these RPCs.
REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.accept_multi_team_trade_atomic(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_multi_team_trade_atomic(uuid, uuid, uuid[]) TO service_role;
