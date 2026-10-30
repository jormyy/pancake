-- Canonical SQL source for public.claim_trade_value_sync.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.claim_trade_value_sync(p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.trade_value_sync_state SET request_id=p_request_id,last_request_at=clock_timestamp()
  WHERE id
    AND (fetched_at IS NULL OR (fetched_at AT TIME ZONE 'America/New_York')::date<(clock_timestamp() AT TIME ZONE 'America/New_York')::date)
    AND (request_id IS NULL OR last_request_at IS NULL OR last_request_at<clock_timestamp()-interval '3 minutes');
  RETURN FOUND;
END;
$$;
