-- Backfill draft picks for any league members who are missing them,
-- and update join_league_by_invite_code to create picks on join.
--
-- Expected picks per member:
--   2027 rounds 1-3, 2028 rounds 1-3, 2029 rounds 1-3, 2030 rounds 1-2

INSERT INTO draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
SELECT lm.league_id, s.season_year, s.round, lm.id, lm.id
FROM league_members lm
CROSS JOIN (VALUES
    (2027, 1), (2027, 2), (2027, 3),
    (2028, 1), (2028, 2), (2028, 3),
    (2029, 1), (2029, 2), (2029, 3),
    (2030, 1), (2030, 2)
) AS s(season_year, round)
WHERE NOT EXISTS (
    SELECT 1 FROM draft_picks dp
    WHERE dp.league_id   = lm.league_id
      AND dp.season_year = s.season_year
      AND dp.round       = s.round
      AND dp.original_owner_id = lm.id
);

-- Update join_league_by_invite_code to create picks for the new member
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
  v_league    public.leagues%ROWTYPE;
  v_user_id   uuid := (SELECT auth.uid());
  v_existing  uuid;
  v_member_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT *
  INTO   v_league
  FROM   public.leagues
  WHERE  invite_code = upper(trim(p_invite_code));

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  SELECT id
  INTO   v_existing
  FROM   public.league_members
  WHERE  league_id = v_league.id
    AND  user_id   = v_user_id;

  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league.id, v_user_id, 'manager', p_team_name)
  RETURNING id INTO v_member_id;

  -- Create draft picks for the new member
  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league.id, s.season_year, s.round, v_member_id, v_member_id
  FROM (VALUES
      (2027, 1), (2027, 2), (2027, 3),
      (2028, 1), (2028, 2), (2028, 3),
      (2029, 1), (2029, 2), (2029, 3),
      (2030, 1), (2030, 2)
  ) AS s(season_year, round)
  WHERE NOT EXISTS (
      SELECT 1 FROM public.draft_picks dp
      WHERE dp.league_id        = v_league.id
        AND dp.season_year      = s.season_year
        AND dp.round            = s.round
        AND dp.original_owner_id = v_member_id
  );

  RETURN jsonb_build_object(
    'id',     v_league.id,
    'name',   v_league.name,
    'status', v_league.status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text) TO authenticated;
