-- Record the stable identity and input contract for the dynasty decision RPC.

COMMENT ON FUNCTION public.get_dynasty_decision_inputs(uuid, uuid, int, uuid[], text, int, int) IS
  'Returns league-scoped dynasty decision inputs for one authenticated league member.';
