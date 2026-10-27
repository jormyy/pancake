-- Canonical SQL source for public.auto_set_lineup_service_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.auto_set_lineup_service_atomic(
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
  __request_context := private.request_begin('public.auto_set_lineup_service_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_game_date), NULL, p_member_id::text || ':' || p_game_date::text);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_user_id uuid;
BEGIN
  SELECT user_id
    INTO v_user_id
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
  PERFORM public.auto_set_lineup_atomic(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
