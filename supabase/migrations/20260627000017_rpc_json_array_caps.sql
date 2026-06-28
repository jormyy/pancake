-- Authenticated RPC workload hardening:
-- - Bound authenticated JSON-array RPC workloads before any expansion/loops.

ALTER FUNCTION public.update_lineup_slots_atomic(uuid, jsonb)
  RENAME TO update_lineup_slots_atomic_unchecked_legacy;

CREATE OR REPLACE FUNCTION public.update_lineup_slots_atomic(
  p_league_id uuid,
  p_slots     jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RAISE EXCEPTION 'p_slots must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_slots) > 16 THEN
    RAISE EXCEPTION 'Too many lineup slot entries.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.update_lineup_slots_atomic_unchecked_legacy(p_league_id, p_slots);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_moves jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_moves) > 64 THEN
    RAISE EXCEPTION 'Too many lineup moves.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM public.set_player_slot_moves_atomic_unchecked_legacy(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    p_moves
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_assignments) > 64 THEN
    RAISE EXCEPTION 'Too many lineup assignments.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM public.auto_set_lineup_atomic_unchecked_legacy(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic_unchecked_legacy(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic_unchecked_legacy(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic_unchecked_legacy(uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic_unchecked_legacy(uuid, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_lineup_slots_atomic(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_lineup_slots_atomic(uuid, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) TO authenticated, service_role;
