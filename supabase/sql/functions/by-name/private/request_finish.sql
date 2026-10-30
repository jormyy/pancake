-- Canonical SQL source for private.request_finish.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.request_finish(p_context jsonb, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_context IS NULL THEN RETURN; END IF;
  INSERT INTO private.request_receipts(request_id, actor, function, input_hash, result)
  VALUES ((p_context->>'id')::uuid, (p_context->>'actor')::uuid, p_context->>'function', p_context->>'input_hash', COALESCE(p_result, 'null'::jsonb));
  PERFORM set_config('pancake.request_active', '', true);
END;
$$;
