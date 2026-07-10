-- Canonical SQL source for public.activate_roster_player_with_lineup_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.activate_roster_player_with_lineup_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text,
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_slot_type roster_slot_type DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_activate_player_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF (p_free_roster_player_id IS NULL AND p_free_action IS NOT NULL)
     OR (p_free_roster_player_id IS NOT NULL AND p_free_action IS NULL) THEN
    RAISE EXCEPTION 'Overflow player and overflow action must be provided together.'
      USING ERRCODE = '22023';
  END IF;

  IF p_free_roster_player_id IS NOT NULL
     AND p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  IF p_slot_type = 'IR'::roster_slot_type THEN
    RAISE EXCEPTION 'Use roster IR actions instead of lineup IR assignment.'
      USING ERRCODE = '22023';
  END IF;

  IF p_free_roster_player_id IS NOT NULL THEN
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
  END IF;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;

  IF p_slot_type IS NOT NULL AND p_slot_type <> 'BE'::roster_slot_type THEN
    SELECT player_id
      INTO v_activate_player_id
      FROM public.roster_players
     WHERE id = p_activate_roster_player_id
       AND member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id;

    IF v_activate_player_id IS NULL THEN
      RAISE EXCEPTION 'Activated player is not on this roster.'
        USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.set_player_slot_atomic(
      p_member_id,
      p_league_id,
      p_league_season_id,
      v_activate_player_id,
      p_game_date,
      p_slot_type,
      p_week_number
    );
  END IF;
END;
$$;
