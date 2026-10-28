CREATE OR REPLACE FUNCTION public.claim_trade_value_sync(p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.trade_value_sync_state SET request_id=p_request_id,last_request_at=clock_timestamp()
  WHERE id AND (last_request_at IS NULL OR (last_request_at AT TIME ZONE 'America/New_York')::date<(clock_timestamp() AT TIME ZONE 'America/New_York')::date);
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_trade_value_sync(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_trade_value_sync(uuid) TO service_role;
