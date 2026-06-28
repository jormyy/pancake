-- Profile privacy and invite capacity hardening:
-- - setup league invites must not overfill the intended 10-team league size
-- - authenticated clients must not enumerate unrelated profiles or read push tokens

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
  v_league           public.leagues%ROWTYPE;
  v_user_id          uuid := (SELECT auth.uid());
  v_invite_code      text := upper(trim(coalesce(p_invite_code, '')));
  v_existing         uuid;
  v_member_id        uuid;
  v_member_count     int;
  v_league_season_id uuid;
  v_season_year      int;
  v_priority         int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_invite_code !~ '^[A-Z0-9]{16}$' THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  SELECT *
  INTO   v_league
  FROM   public.leagues
  WHERE  invite_code = v_invite_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  IF v_league.status IS DISTINCT FROM 'setup'::public.league_status THEN
    RAISE EXCEPTION 'This league is no longer accepting new members.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
  INTO   v_existing
  FROM   public.league_members
  WHERE  league_id = v_league.id
    AND  user_id   = v_user_id;

  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  SELECT count(*)
  INTO   v_member_count
  FROM   public.league_members
  WHERE  league_id = v_league.id;

  IF v_member_count >= 10 THEN
    RAISE EXCEPTION 'This league is full.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, season_year
  INTO   v_league_season_id, v_season_year
  FROM   public.league_seasons
  WHERE  league_id = v_league.id
    AND  is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League has no active season.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league.id, v_user_id, 'manager', trim(p_team_name))
  RETURNING id INTO v_member_id;

  SELECT COALESCE(max(wp.priority), 0) + 1
  INTO   v_priority
  FROM   public.waiver_priorities AS wp
  WHERE  wp.league_id = v_league.id
    AND  wp.league_season_id = v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league.id, v_league_season_id, v_member_id, v_priority);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league.id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year + 1, v_season_year + 5) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  RETURN jsonb_build_object(
    'id',     v_league.id,
    'name',   v_league.name,
    'status', v_league.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.join_league_by_invite_code(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text)
  TO authenticated, service_role;

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_self_or_shared_league" ON public.profiles;

CREATE POLICY "profiles_select_self_or_shared_league" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.league_members AS self_member
      JOIN public.league_members AS visible_member
        ON visible_member.league_id = self_member.league_id
      WHERE self_member.user_id = (SELECT auth.uid())
        AND visible_member.user_id = profiles.id
    )
  );

REVOKE SELECT ON public.profiles FROM anon, authenticated;
GRANT SELECT (
  id,
  username,
  display_name,
  avatar_url,
  timezone,
  created_at,
  updated_at
) ON public.profiles TO authenticated;
GRANT SELECT ON public.profiles TO service_role;
REVOKE SELECT (push_token) ON public.profiles FROM anon, authenticated;
GRANT SELECT (push_token) ON public.profiles TO service_role;

CREATE OR REPLACE FUNCTION public.is_username_available(p_username text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE username = trim(p_username)
  );
$$;

REVOKE ALL ON FUNCTION public.is_username_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_username_available(text) TO anon, authenticated;
