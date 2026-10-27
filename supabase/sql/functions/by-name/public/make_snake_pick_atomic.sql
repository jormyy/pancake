-- Canonical SQL source for public.make_snake_pick_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.make_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_to_taxi boolean DEFAULT false
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
  __request_context := private.request_begin('public.make_snake_pick_atomic', jsonb_build_array(p_draft_id, p_member_id, p_player_id, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  __request_result := private.make_snake_pick_atomic_internal(
    p_draft_id,
    p_member_id,
    p_player_id,
    false,
    p_to_taxi
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
