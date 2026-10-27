CREATE OR REPLACE FUNCTION public.save_client_settings_atomic(p_kind text, p_settings jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  context jsonb;
  actor uuid := auth.uid();
  v_member_id uuid;
  v_league_id uuid;
  v_season_id uuid;
BEGIN
  context := private.request_begin('public.save_client_settings_atomic', jsonb_build_array(p_kind, p_settings));
  IF (context->>'replay')::boolean THEN RETURN; END IF;
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required.' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Settings must be an object.' USING ERRCODE='22023'; END IF;
  IF p_kind = 'lineup_optimizer' THEN
    v_member_id := (p_settings->>'memberId')::uuid;
    v_league_id := (p_settings->>'leagueId')::uuid;
    v_season_id := (p_settings->>'seasonId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.league_members m JOIN public.league_seasons s ON s.league_id=m.league_id
      WHERE m.id=v_member_id AND m.league_id=v_league_id AND m.user_id=actor AND s.id=v_season_id AND s.is_current) THEN
      RAISE EXCEPTION 'Settings require your current league season.' USING ERRCODE='42501';
    END IF;
    INSERT INTO public.lineup_optimizer_settings(member_id,league_id,league_season_id,enabled,enabled_at)
    VALUES(v_member_id,v_league_id,v_season_id,(p_settings->>'enabled')::boolean,
      CASE WHEN (p_settings->>'enabled')::boolean THEN now() ELSE NULL END)
    ON CONFLICT ON CONSTRAINT lineup_optimizer_settings_pkey DO UPDATE SET enabled=EXCLUDED.enabled,enabled_at=EXCLUDED.enabled_at;
  ELSIF p_kind = 'team' THEN
    UPDATE public.league_members SET team_name=p_settings->>'teamName'
    WHERE id=(p_settings->>'memberId')::uuid AND user_id=actor;
    IF NOT FOUND THEN RAISE EXCEPTION 'Team membership required.' USING ERRCODE='42501'; END IF;
  ELSIF p_kind = 'notifications' THEN
    IF (p_settings->>'userId')::uuid IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Access denied.' USING ERRCODE='42501'; END IF;
    INSERT INTO public.notification_preferences(user_id,trade_enabled,waiver_enabled,draft_enabled,activity_enabled,master_enabled,category_settings,event_settings,updated_at)
    VALUES(actor,(p_settings->>'tradeEnabled')::boolean,(p_settings->>'waiverEnabled')::boolean,
      (p_settings->>'draftEnabled')::boolean,(p_settings->>'activityEnabled')::boolean,
      COALESCE((p_settings->>'masterEnabled')::boolean,true),COALESCE(p_settings->'categories','{}'::jsonb),COALESCE(p_settings->'events','{}'::jsonb),now())
    ON CONFLICT(user_id) DO UPDATE SET trade_enabled=EXCLUDED.trade_enabled,waiver_enabled=EXCLUDED.waiver_enabled,
      draft_enabled=EXCLUDED.draft_enabled,activity_enabled=EXCLUDED.activity_enabled,master_enabled=EXCLUDED.master_enabled,
      category_settings=EXCLUDED.category_settings,event_settings=EXCLUDED.event_settings,updated_at=EXCLUDED.updated_at;
  ELSE
    RAISE EXCEPTION 'Unknown settings kind.' USING ERRCODE='22023';
  END IF;
  PERFORM private.request_finish(context,'null'::jsonb);
END;
$$;
