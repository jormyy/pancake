-- Internal Edge token and rookie commissioner hardening: require a dedicated Edge internal token and
-- make rookie draft league activation commissioner-only.

CREATE OR REPLACE FUNCTION public.invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _base_url text;
  _token text;
BEGIN
  _base_url := NULLIF(current_setting('app.supabase_url', true), '');
  _token := NULLIF(current_setting('app.edge_internal_token', true), '');

  IF _token IS NULL THEN
    SELECT NULLIF(decrypted_secret, '')
      INTO _token
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_edge_internal_token'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _base_url IS NULL OR _token IS NULL THEN
    RAISE WARNING '[cron] app.supabase_url and a dedicated Edge internal token must be set; skipping %.', function_name;
    RETURN;
  END IF;

  PERFORM net.http_post(
    _base_url || '/functions/v1/' || function_name,
    body,
    NULL,
    jsonb_build_object(
      'x-internal-function-token', _token,
      'Content-Type', 'application/json'
    ),
    30000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function(text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.activate_rookie_draft_league_atomic(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_rows int;
  v_unfilled_picks int;
BEGIN
  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT private.is_commissioner(v_draft.league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can activate this rookie draft league.'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status <> 'completed'::draft_status THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = v_draft.league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND OR v_draft.league_season_id <> v_current_season.id THEN
    RETURN false;
  END IF;

  SELECT count(*)
    INTO v_unfilled_picks
    FROM snake_draft_picks
   WHERE draft_id = v_draft.id
     AND player_id IS NULL;

  IF v_unfilled_picks > 0 THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
     AND current_draft.status IN (
       'pending'::draft_status,
       'in_progress'::draft_status,
       'paused'::draft_status
     )
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM league_seasons AS season
    JOIN league_members AS member
      ON member.league_id = v_draft.league_id
    LEFT JOIN roster_players AS roster
      ON roster.league_id = v_draft.league_id
     AND roster.league_season_id = season.id
     AND roster.member_id = member.id
     AND roster.is_on_ir = false
     AND roster.is_on_taxi = false
   WHERE season.id = v_current_season.id
   GROUP BY member.id
  HAVING count(roster.id) > v_league.roster_size
   LIMIT 1;

  IF FOUND THEN
    RETURN false;
  END IF;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id
     AND status = 'drafting';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) TO service_role;
