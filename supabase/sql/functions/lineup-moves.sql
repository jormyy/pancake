-- Canonical SQL source for lineup moves.
-- Edit this file first, then copy changed function statements into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies the latest migration definitions still match.

CREATE OR REPLACE FUNCTION public.lineup_slot_allowed_positions(
  p_slot_type roster_slot_type
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_slot_type
    WHEN 'PG'::roster_slot_type THEN ARRAY['PG']::text[]
    WHEN 'SG'::roster_slot_type THEN ARRAY['SG']::text[]
    WHEN 'SF'::roster_slot_type THEN ARRAY['SF']::text[]
    WHEN 'PF'::roster_slot_type THEN ARRAY['PF']::text[]
    WHEN 'C'::roster_slot_type THEN ARRAY['C']::text[]
    WHEN 'G'::roster_slot_type THEN ARRAY['PG', 'SG']::text[]
    WHEN 'F'::roster_slot_type THEN ARRAY['SF', 'PF']::text[]
    WHEN 'UTIL'::roster_slot_type THEN ARRAY['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
    WHEN 'BE'::roster_slot_type THEN ARRAY['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
    ELSE '{}'::text[]
  END
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
  PERFORM public.auto_set_lineup_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
END;
$$;
