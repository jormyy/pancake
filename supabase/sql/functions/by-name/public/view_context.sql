-- Canonical SQL source for public.view_context.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_context(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE member public.league_members%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  today date; week integer; context_version bigint; dirty boolean;
BEGIN
  IF jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'View parameters must be an object.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO member FROM public.league_members WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'This screen is not available.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO league FROM public.leagues WHERE id = p_league_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'This screen is not available.' USING ERRCODE = '42501'; END IF;
  today := (now() AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date;
  SELECT * INTO season FROM public.league_seasons WHERE league_id = p_league_id
    AND (p_params->>'seasonId' IS NULL OR id = (p_params->>'seasonId')::uuid)
    ORDER BY is_current DESC, season_year DESC LIMIT 1;
  IF p_params->>'seasonId' IS NOT NULL AND season.id IS NULL THEN RAISE EXCEPTION 'This season is not available.' USING ERRCODE = '42501'; END IF;
  SELECT week_number INTO week FROM public.season_weeks WHERE season_year = season.season_year
    ORDER BY CASE WHEN today BETWEEN week_start AND week_end THEN 0 WHEN week_start > today THEN 1 ELSE 2 END,
      CASE WHEN week_start >= today THEN week_start END, week_end DESC LIMIT 1;
  SELECT q.version, q.dirty INTO context_version, dirty FROM private.screen_refresh_queue q WHERE q.league_season_id = season.id;
  dirty:=COALESCE(dirty,true) OR EXISTS(SELECT 1 FROM private.league_version_pending WHERE league_id=p_league_id);
  RETURN jsonb_build_object('leagueId', p_league_id, 'memberId', p_member_id, 'league', to_jsonb(league),
    'member', to_jsonb(member), 'season', CASE WHEN season.id IS NULL THEN NULL ELSE to_jsonb(season) END,
    'seasonId', season.id, 'seasonYear', COALESCE((p_params->>'seasonYear')::integer, season.season_year, public.current_season_year_et()),
    'weekNumber', COALESCE((p_params->>'weekNumber')::integer, week), 'today', today,
    'pendingIncomingCount', public.get_pending_trade_count(p_member_id, p_league_id),
    'version', context_version, 'stale', COALESCE(dirty, true))
    || CASE WHEN p_params ? 'tradeId' THEN jsonb_build_object('tradeAnalysisStale',
      CASE WHEN private.can_read_trade((p_params->>'tradeId')::uuid) THEN
        COALESCE((SELECT published.valid_until<=now() OR published.version IS DISTINCT FROM context_version
          FROM private.trade_value_publications published JOIN public.trades trade ON trade.id=published.trade_id
          WHERE trade.id=(p_params->>'tradeId')::uuid AND trade.league_id=p_league_id
            AND trade.league_season_id=season.id),true) OR COALESCE(dirty,true)
      ELSE true END) ELSE '{}'::jsonb END;
END;
$$;
