-- ============================================================
-- Migration: join_league_by_invite_code RPC
--
-- Once RLS is enabled on the `leagues` table, a non-member cannot
-- SELECT leagues rows — which breaks the joinLeague() flow in
-- lib/league.ts, which queries leagues by invite_code BEFORE the
-- user exists in league_members.
--
-- This SECURITY DEFINER function bypasses RLS for that one operation,
-- performing all three steps atomically: find league → check duplicate
-- → insert member. The frontend replaces three direct queries with a
-- single supabase.rpc('join_league_by_invite_code', { ... }) call.
--
-- Grant: only the `authenticated` role can execute this function.
-- ============================================================

CREATE OR REPLACE FUNCTION public.join_league_by_invite_code(
  p_invite_code text,
  p_team_name   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league   public.leagues%ROWTYPE;
  v_user_id  uuid := (SELECT auth.uid());
  v_existing uuid;
BEGIN
  -- Require an authenticated session
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Find the league by invite code (case-insensitive, whitespace-trimmed)
  SELECT *
  INTO   v_league
  FROM   public.leagues
  WHERE  invite_code = upper(trim(p_invite_code));

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  -- Prevent duplicate membership
  SELECT id
  INTO   v_existing
  FROM   public.league_members
  WHERE  league_id = v_league.id
    AND  user_id   = v_user_id;

  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  -- Insert the new member row
  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league.id, v_user_id, 'manager', p_team_name);

  -- Return the league summary the frontend needs
  RETURN jsonb_build_object(
    'id',     v_league.id,
    'name',   v_league.name,
    'status', v_league.status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text) TO authenticated;
