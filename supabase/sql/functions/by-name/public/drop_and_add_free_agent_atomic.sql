-- Canonical SQL source for public.drop_and_add_free_agent_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.drop_and_add_free_agent_atomic(
  p_roster_player_id uuid,
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.drop_and_add_free_agent_atomic', jsonb_build_array(p_roster_player_id, p_member_id, p_league_id, p_player_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM public.drop_player_atomic(p_roster_player_id);
  PERFORM public.add_free_agent_atomic(p_member_id, p_league_id, p_player_id);
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
