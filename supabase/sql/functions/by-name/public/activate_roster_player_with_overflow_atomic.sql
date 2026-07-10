-- Canonical SQL source for public.activate_roster_player_with_overflow_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
