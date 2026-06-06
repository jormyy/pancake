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
  v_rows int;
BEGIN
  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE league_id = v_draft.league_id
       AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only league members can activate this rookie draft league.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status <> 'completed'::draft_status THEN
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
   WHERE season.id = v_draft.league_season_id
   GROUP BY member.id
  HAVING count(roster.id) > (
    SELECT roster_size FROM leagues WHERE id = v_draft.league_id
  )
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
