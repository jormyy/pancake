-- Canonical SQL source for private.claim_request.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.claim_request(p_request_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  saved private.request_receipts%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'A request ID and actor are required.' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 731));
  SELECT * INTO saved FROM private.request_receipts WHERE request_id = p_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF saved.actor IS DISTINCT FROM p_actor
    OR saved.function IS DISTINCT FROM current_setting('pancake.request_function', true)
    OR saved.input_hash IS DISTINCT FROM current_setting('pancake.request_input_hash', true) THEN
    RAISE EXCEPTION 'Request ID already belongs to another action.' USING ERRCODE = '22023';
  END IF;
  RETURN saved.result;
END;
$$;
