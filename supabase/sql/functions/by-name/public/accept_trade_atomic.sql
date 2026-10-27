-- Canonical SQL source for public.accept_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.accept_trade_atomic', jsonb_build_array(p_trade_id, p_accepting_member_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  __request_result := private.accept_trade_participant_atomic(
    p_trade_id,
    p_accepting_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
