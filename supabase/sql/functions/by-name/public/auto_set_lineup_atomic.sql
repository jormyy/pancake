-- Canonical SQL source for public.auto_set_lineup_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.auto_set_lineup_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_game_date, p_assignments), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM 1 FROM public.league_members
  WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_assignments) > 64 THEN
    RAISE EXCEPTION 'Too many lineup assignments.'
      USING ERRCODE = '22023';
  END IF;

  IF p_game_date < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.auto_set_lineup_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
  INSERT INTO public.league_events(league_id,member_id,kind,summary,detail)
  VALUES(p_league_id,p_member_id,'lineup.auto_set','Lineup auto-set',
    jsonb_build_object('league_season_id',p_league_season_id,'game_date',p_game_date,'assignments',p_assignments));
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
