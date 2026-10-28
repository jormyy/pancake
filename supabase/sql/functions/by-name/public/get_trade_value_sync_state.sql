CREATE OR REPLACE FUNCTION public.get_trade_value_sync_state()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(state) FROM private.trade_value_sync_state state WHERE id;
$$;
REVOKE ALL ON FUNCTION public.get_trade_value_sync_state() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_value_sync_state() TO service_role;
