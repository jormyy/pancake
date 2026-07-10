-- Trade list queries embed participant routing. RLS remains the row-level boundary.
SET lock_timeout = '5s';
SET statement_timeout = '2min';

GRANT SELECT ON public.trade_participants TO authenticated;
REVOKE SELECT ON public.trade_participants FROM anon;

RESET statement_timeout;
RESET lock_timeout;
