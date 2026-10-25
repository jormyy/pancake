ALTER TABLE public.league_announcements
  DROP CONSTRAINT league_announcements_author_member_id_fkey,
  ALTER COLUMN author_member_id DROP NOT NULL,
  ADD CONSTRAINT league_announcements_author_member_id_fkey FOREIGN KEY(author_member_id)
    REFERENCES public.league_members(id) ON DELETE SET NULL;
CREATE OR REPLACE FUNCTION public.notif_publish_announcement_atomic(p_league_id uuid,p_body text,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE m uuid; saved public.league_announcements%ROWTYPE; body text:=btrim(p_body);
BEGIN
  IF NOT private.is_commissioner(p_league_id) THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
  IF body IS NULL OR length(body) NOT BETWEEN 1 AND 500 OR p_request_id IS NULL THEN RAISE EXCEPTION 'Announcement must contain 1 to 500 characters' USING ERRCODE='22023'; END IF;
  SELECT id INTO m FROM public.league_members WHERE league_id=p_league_id AND user_id=(SELECT auth.uid());
  INSERT INTO public.league_announcements(id,league_id,author_member_id,body) VALUES(p_request_id,p_league_id,m,body) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO saved FROM public.league_announcements WHERE id=p_request_id;
  IF saved.league_id IS DISTINCT FROM p_league_id OR saved.author_member_id IS DISTINCT FROM m OR saved.body IS DISTINCT FROM body THEN RAISE EXCEPTION 'Announcement request already used' USING ERRCODE='23505'; END IF;
  RETURN saved.id;
END;
$$;
