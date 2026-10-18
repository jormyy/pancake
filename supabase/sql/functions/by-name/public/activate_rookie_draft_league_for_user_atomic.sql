CREATE OR REPLACE FUNCTION public.activate_rookie_draft_league_for_user_atomic(p_draft_id uuid,p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_draft public.drafts%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'A commissioner actor is required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text),0);
  SELECT * INTO v_draft FROM public.drafts WHERE id=p_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.leagues WHERE id=v_draft.league_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.league_members WHERE league_id=v_draft.league_id AND user_id=p_user_id
    AND role IN ('commissioner','co_commissioner') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
  RETURN private.activate_rookie_draft_league_if_ready(p_draft_id);
END;
$$;
