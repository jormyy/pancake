-- ============================================================
-- Migration: create_league RPC
--
-- Direct INSERT into leagues fails because after the insert
-- the SELECT policy (id IN my_league_ids()) blocks the RETURNING
-- result — the user isn't in league_members yet, so PostgREST
-- reports "new row violates row-level security policy for table
-- 'leagues'".
--
-- This SECURITY DEFINER function creates the league, commissioner
-- member row, league season, and initial draft picks atomically,
-- then returns the data the frontend needs.
-- ============================================================

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
  v_user_id     uuid := (SELECT auth.uid());
  v_slug        text;
  v_invite_code text;
  v_league_id   uuid;
  v_member_id   uuid;
  v_season_year int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Derive season year: Oct+ means next calendar year (same logic as client)
  v_season_year := CASE
    WHEN extract(month FROM now()) >= 10 THEN extract(year FROM now())::int + 1
    ELSE extract(year FROM now())::int
  END;

  -- Generate slug and invite code
  v_slug        := regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')
                   || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  -- Insert league (triggers seed_default_lineup_slots + seed_default_scoring_settings)
  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget)
  VALUES (p_name, v_slug, v_invite_code, v_user_id, p_auction_budget)
  RETURNING id INTO v_league_id;

  -- Insert commissioner member row
  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', p_team_name)
  RETURNING id INTO v_member_id;

  -- Insert league season
  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true);

  -- Insert initial draft picks for the commissioner
  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, s.season_year, s.round, v_member_id, v_member_id
  FROM (VALUES
    (2027, 1), (2027, 2), (2027, 3),
    (2028, 1), (2028, 2), (2028, 3),
    (2029, 1), (2029, 2), (2029, 3),
    (2030, 1), (2030, 2)
  ) AS s(season_year, round);

  RETURN jsonb_build_object(
    'id',              v_league_id,
    'name',            p_name,
    'slug',            v_slug,
    'invite_code',     v_invite_code,
    'commissioner_id', v_user_id,
    'auction_budget',  p_auction_budget,
    'status',          'pre_draft'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_league(text, text, int) TO authenticated;
