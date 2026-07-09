-- Intermediate public.get_trades_for_member definition removed; the final canonical definition is applied later in this branch.


REVOKE ALL ON FUNCTION public.get_trades_for_member(uuid, uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trades_for_member(uuid, uuid, int, int) TO authenticated, service_role;
