-- Canonical SQL source for public.activate_rookie_draft_league_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT private.is_commissioner(v_draft.league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can activate this rookie draft league.'
      USING ERRCODE = '42501';
  END IF;

  RETURN private.activate_rookie_draft_league_if_ready(p_draft_id);
END;
$$;
