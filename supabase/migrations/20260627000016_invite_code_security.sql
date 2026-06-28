-- Invite-code security hardening:
-- - Replace six-character invite codes with 16-character uppercase codes.
-- - Reject malformed invite-code joins before indexed league lookup.

CREATE OR REPLACE FUNCTION public.generate_invite_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text;
BEGIN
  LOOP
    v_code := upper(encode(extensions.gen_random_bytes(8), 'hex'));
    EXIT WHEN NOT EXISTS (
      SELECT 1
        FROM public.leagues
       WHERE invite_code = v_code
    );
  END LOOP;

  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_invite_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_invite_code() FROM anon;
REVOKE ALL ON FUNCTION public.generate_invite_code() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_invite_code() TO service_role;

UPDATE public.leagues
   SET invite_code = public.generate_invite_code()
 WHERE invite_code IS NULL
    OR invite_code !~ '^[A-Z0-9]{16}$';

ALTER TABLE public.leagues
  DROP CONSTRAINT IF EXISTS leagues_invite_code_format;

ALTER TABLE public.leagues
  ADD CONSTRAINT leagues_invite_code_format
  CHECK (invite_code IS NULL OR invite_code ~ '^[A-Z0-9]{16}$');

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

  IF p_auction_budget IS NULL OR p_auction_budget <= 0 THEN
    RAISE EXCEPTION 'auction_budget must be a positive integer.'
      USING ERRCODE = 'P0001';
  END IF;

  v_season_year := public.current_season_year_et();

  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
            || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := public.generate_invite_code();

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
    'status',          'setup'
  );
END;
$$;

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

REVOKE ALL ON FUNCTION public.create_league(text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_league(text, text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_league(text, text, int) TO authenticated;

REVOKE ALL ON FUNCTION public.join_league_by_invite_code(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text)
  TO authenticated, service_role;
