CREATE OR REPLACE FUNCTION public.resolve_trade_value_review(p_source_id text,p_player_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
    WHERE member.user_id=auth.uid() AND league.deleted_at IS NULL AND member.role IN('commissioner','co_commissioner'))
    AND COALESCE(auth.jwt()->'app_metadata'->>'role','')<>'admin' THEN
    RAISE EXCEPTION 'Only commissioners and admins can resolve value matches.' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM private.trade_value_sync_state WHERE id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.players WHERE id=p_player_id) THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.dynasty_rankings WHERE source='onenumberhoops.com' AND player_id=p_player_id AND source_player_id<>p_source_id) THEN
    RAISE EXCEPTION 'Player already has a source value.' USING ERRCODE='22023';
  END IF;
  UPDATE public.trade_value_reviews SET resolved_player_id=p_player_id,resolved_by=auth.uid(),resolved_at=clock_timestamp()
    WHERE source_id=p_source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review not found.' USING ERRCODE='22023'; END IF;
  UPDATE public.dynasty_rankings SET player_id=p_player_id,updated_at=clock_timestamp()
    WHERE source='onenumberhoops.com' AND source_player_id=p_source_id;
  INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
    SELECT id,'resources',1,NULL,NULL FROM public.leagues WHERE deleted_at IS NULL
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,scopes=NULL,details=NULL,updated_at=clock_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_trade_value_review(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_trade_value_review(text,uuid) TO authenticated;
