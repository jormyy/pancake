-- Canonical SQL source for public.toggle_ir_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.toggle_ir_atomic', jsonb_build_array(p_roster_player_id, p_to_ir, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM private.toggle_ir_for_activation(p_roster_player_id,p_to_ir,p_user_id,NULL);
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
