-- Canonical SQL source for private.lock_live_poll_holder.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lock_live_poll_holder(p_holder uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.live_poll_leases WHERE lock_key = 779001
    AND holder_id = p_holder AND expires_at > clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Live poll lease expired or changed' USING ERRCODE='40001'; END IF;
END;
$$;
