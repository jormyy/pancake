-- Canonical SQL source for public.notif_publish_announcement_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.notif_publish_announcement_atomic(p_league_id uuid,p_body text,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
BEGIN
  __request_context := private.request_begin('public.notif_publish_announcement_atomic', jsonb_build_array(p_league_id, p_body, p_request_id), p_request_id, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE m uuid; saved public.league_announcements%ROWTYPE; body text:=btrim(p_body);
BEGIN
  IF NOT private.is_commissioner(p_league_id) THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
  IF body IS NULL OR length(body) NOT BETWEEN 1 AND 500 OR p_request_id IS NULL THEN RAISE EXCEPTION 'Announcement must contain 1 to 500 characters' USING ERRCODE='22023'; END IF;
  SELECT id INTO m FROM public.league_members WHERE league_id=p_league_id AND user_id=(SELECT auth.uid());
  INSERT INTO public.league_announcements(id,league_id,author_member_id,body) VALUES(p_request_id,p_league_id,m,body) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO saved FROM public.league_announcements WHERE id=p_request_id;
  IF saved.league_id IS DISTINCT FROM p_league_id OR saved.author_member_id IS DISTINCT FROM m OR saved.body IS DISTINCT FROM body THEN RAISE EXCEPTION 'Announcement request already used' USING ERRCODE='23505'; END IF;
  __request_result := saved.id; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
