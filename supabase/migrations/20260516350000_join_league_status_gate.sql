-- ──────────────────────────────────────────────────────────────────────────
-- join_league_by_invite_code: gate on leagues.status = 'setup'
-- ──────────────────────────────────────────────────────────────────────────
-- Problem (SLICE A, iter 35):
--   The SECURITY DEFINER RPC join_league_by_invite_code inserted a new
--   league_members row regardless of the league's lifecycle status. A user
--   in possession of a valid invite code could therefore join a league
--   that was already drafting / active / in playoffs / offseason / archived,
--   disrupting an in-progress season (roster mid-draft, waiver priority
--   churn, draft-pick generation against a season that has shipped, etc.).
--
-- Fix:
--   After fetching the league row, raise a user-facing P0001 error unless
--   the status is exactly 'setup'. All other logic — invite-code lookup,
--   duplicate-member check, current-season lookup, league_members insert,
--   waiver_priorities row, draft_picks generation — is preserved verbatim
--   from the previous definition (20260512000011).
--
--   Service-role bypass is intentionally NOT added. Legitimate joins by
--   authenticated end users only happen pre-draft; downstream lifecycle
--   transitions (commissioner-driven add/replace flows) operate via other
--   RPCs and direct service-role writes, not this invite-code path.
--
--   The grant from 20260516320000 (REVOKE ALL FROM PUBLIC, anon; GRANT
--   EXECUTE TO authenticated, service_role) is preserved and re-issued
--   here so the migration is self-contained / idempotent.
-- ──────────────────────────────────────────────────────────────────────────

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
  WHERE  invite_code = upper(trim(p_invite_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  -- Status gate: invite codes only work pre-draft.
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

-- Preserve the lockdown grant established in 20260516320000.
REVOKE ALL ON FUNCTION public.join_league_by_invite_code(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_league_by_invite_code(text, text)
  TO authenticated, service_role;
