-- Canonical SQL source for public.set_player_slot_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.set_player_slot_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_game_date date,
  p_slot_type roster_slot_type,
  p_week_number int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.set_player_slot_moves_atomic(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    jsonb_build_array(jsonb_build_object(
      'player_id', p_player_id,
      'slot_type', p_slot_type
    ))
  );
END;
$$;
