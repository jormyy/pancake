-- Ensure every league member has a current-season waiver priority from the
-- moment they join. The soak push/waiver path exposed seeded leagues that had
-- future pick banks but no initial waiver_priorities rows until season reset.

CREATE OR REPLACE FUNCTION public.create_league(
  p_name           text,
  p_team_name      text,
  p_auction_budget int DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id          uuid := (SELECT auth.uid());
  v_slug             text;
  v_invite_code      text;
  v_league_id        uuid;
  v_member_id        uuid;
  v_league_season_id uuid;
  v_season_year      int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_season_year := CASE
    WHEN extract(month FROM now()) >= 10 THEN extract(year FROM now())::int + 1
    ELSE extract(year FROM now())::int
  END;

  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
            || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', trim(p_team_name))
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_league_season_id, v_member_id, 1);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year + 1, v_season_year + 5) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value;

  RETURN jsonb_build_object(
    'id',              v_league_id,
    'name',            trim(p_name),
    'slug',            v_slug,
    'invite_code',     v_invite_code,
    'commissioner_id', v_user_id,
    'auction_budget',  p_auction_budget,
    'status',          'pre_draft'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_league(text, text, int) TO authenticated;

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
  v_existing         uuid;
  v_member_id        uuid;
  v_league_season_id uuid;
  v_season_year      int;
  v_priority         int;
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

GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text) TO authenticated;

WITH missing AS (
  SELECT
    lm.league_id,
    ls.id AS league_season_id,
    lm.id AS member_id,
    COALESCE(existing.max_priority, 0) AS max_priority,
    row_number() OVER (
      PARTITION BY ls.id
      ORDER BY lm.joined_at, lm.id
    ) AS missing_rank
  FROM public.league_seasons AS ls
  JOIN public.league_members AS lm
    ON lm.league_id = ls.league_id
  LEFT JOIN LATERAL (
    SELECT max(wp.priority) AS max_priority
    FROM public.waiver_priorities AS wp
    WHERE wp.league_id = ls.league_id
      AND wp.league_season_id = ls.id
  ) AS existing ON true
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.waiver_priorities AS wp
    WHERE wp.league_id = lm.league_id
      AND wp.league_season_id = ls.id
      AND wp.member_id = lm.id
  )
)
INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
SELECT league_id, league_season_id, member_id, max_priority + missing_rank
FROM missing
ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;
