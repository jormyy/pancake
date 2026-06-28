-- Roster transaction hardening:
-- - Replace UI-composed destructive roster workflows with single transaction RPCs.

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
BEGIN
  PERFORM public.drop_player_atomic(p_roster_player_id);
  PERFORM public.add_free_agent_atomic(p_member_id, p_league_id, p_player_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_roster_player_with_overflow_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  CASE p_free_action
    WHEN 'drop' THEN
      PERFORM public.drop_player_atomic(p_free_roster_player_id);
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_free_roster_player_id, true, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_free_roster_player_id, true, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid roster overflow action: %', p_free_action
        USING ERRCODE = '22023';
  END CASE;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION public.drop_and_add_free_agent_atomic(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.drop_and_add_free_agent_atomic(uuid, uuid, uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.activate_roster_player_with_overflow_atomic(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_roster_player_with_overflow_atomic(uuid, text, uuid, text) TO authenticated, service_role;
