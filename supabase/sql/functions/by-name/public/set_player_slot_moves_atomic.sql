-- Canonical SQL source for public.set_player_slot_moves_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.set_player_slot_moves_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    p_moves
  );
END;
$$;
