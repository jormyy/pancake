-- Canonical SQL source for public.notif_set_player_watch_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.notif_set_player_watch_atomic(p_league_id uuid,p_player_id uuid,p_enabled boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE m uuid;
BEGIN
  SELECT member.id INTO m FROM public.league_members member JOIN public.leagues l ON l.id=member.league_id AND l.deleted_at IS NULL
    WHERE member.league_id=p_league_id AND member.user_id=(SELECT auth.uid());
  IF m IS NULL THEN RAISE EXCEPTION 'League membership required' USING ERRCODE='42501'; END IF;
  IF p_enabled IS NULL OR NOT EXISTS(SELECT 1 FROM public.players WHERE id=p_player_id) THEN RAISE EXCEPTION 'Player and watch choice required' USING ERRCODE='22023'; END IF;
  IF p_enabled THEN
    INSERT INTO public.player_watches(league_id,member_id,player_id) VALUES(p_league_id,m,p_player_id) ON CONFLICT(member_id,player_id) DO NOTHING;
  ELSE DELETE FROM public.player_watches WHERE league_id=p_league_id AND member_id=m AND player_id=p_player_id;
  END IF;
  RETURN p_enabled;
END;
$$;
