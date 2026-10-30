-- Canonical SQL source for public.notif_list_announcements.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.notif_list_announcements(p_league_id uuid)
RETURNS SETOF public.league_announcements LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id AND l.deleted_at IS NULL
    WHERE m.league_id=p_league_id AND m.user_id=(SELECT auth.uid())) THEN RAISE EXCEPTION 'League membership required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT * FROM public.league_announcements WHERE league_id=p_league_id ORDER BY published_at DESC,id DESC LIMIT 50;
END;
$$;
