-- Trade list queries embed participant routing. RLS remains the row-level boundary.
GRANT SELECT ON public.trade_participants TO authenticated;
REVOKE SELECT ON public.trade_participants FROM anon;
