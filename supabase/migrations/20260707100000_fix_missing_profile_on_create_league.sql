-- Captured from production migration history (20260707100000) to reconcile repo/prod drift.
-- These fixes were applied directly to prod and were missing from the repo.

-- Fix: create_league fails when auth user has no profiles row
-- (can happen when user is created via dashboard or profile insert fails at signup)
--
-- Two-part fix:
-- 1. Re-add trigger on auth.users to auto-create a stub profile on signup
-- 2. Update create_league to upsert a stub profile before inserting the league

-- ---------------------------------------------------------------
-- 1. Trigger: auto-create stub profile on new auth user
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email_prefix text;
  v_username     text;
  v_counter      int := 0;
BEGIN
  -- Derive a username from the email prefix, stripping non-alphanumeric chars
  v_email_prefix := lower(regexp_replace(split_part(NEW.email, '@', 1), '[^a-z0-9_]', '', 'g'));
  IF length(v_email_prefix) < 3 THEN
    v_email_prefix := 'user';
  END IF;
  v_username := v_email_prefix;

  -- Ensure uniqueness with a numeric suffix if needed
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
    v_counter  := v_counter + 1;
    v_username := v_email_prefix || v_counter::text;
    IF v_counter > 999 THEN EXIT; END IF; -- safety valve
  END LOOP;

  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    v_username,
    COALESCE(NEW.raw_user_meta_data->>'display_name', v_email_prefix)
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
-- ---------------------------------------------------------------
-- 2. Update create_league: upsert stub profile before inserting
--    the league, so existing profile-less users are fixed inline.
-- ---------------------------------------------------------------
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
  v_user_id      uuid := (SELECT auth.uid());
  v_slug         text;
  v_invite_code  text;
  v_league_id    uuid;
  v_member_id    uuid;
  v_season_year  int;
  v_email_prefix text;
  v_username     text;
  v_counter      int := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Ensure a profiles row exists for this user (handles dashboard-created users
  -- and any case where the signup profile insert failed).
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    SELECT lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]', '', 'g'))
      INTO v_email_prefix
      FROM auth.users
     WHERE id = v_user_id;

    v_email_prefix := COALESCE(NULLIF(v_email_prefix, ''), 'user');
    IF length(v_email_prefix) < 3 THEN v_email_prefix := 'user'; END IF;
    v_username := v_email_prefix;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
      v_counter  := v_counter + 1;
      v_username := v_email_prefix || v_counter::text;
      IF v_counter > 999 THEN EXIT; END IF;
    END LOOP;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES (v_user_id, v_username, v_email_prefix)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- Derive season year: Oct+ means next calendar year
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
