-- Canonical SQL source for public.view_league.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_league(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb; active uuid;
BEGIN
  CASE COALESCE(p_params->>'tab', 'results')
    WHEN 'results' THEN result := public.view_standings(p_league_id, p_member_id, p_params);
    WHEN 'history' THEN result := public.view_activity(p_league_id, p_member_id, p_params);
    WHEN 'picks' THEN result := public.view_picks(p_league_id, p_member_id, p_params);
    WHEN 'draftBoard' THEN result := public.view_picks(p_league_id, p_member_id, p_params);
    WHEN 'settings' THEN result := public.view_settings(p_league_id, p_member_id, p_params);
    WHEN 'draft' THEN result := public.view_draft_rooms(p_league_id, p_member_id, p_params);
    WHEN 'mockRooms' THEN result := public.view_draft_rooms(p_league_id, p_member_id, p_params);
    ELSE RAISE EXCEPTION 'Unknown league tab.' USING ERRCODE = '22023';
  END CASE;
  SELECT id INTO active FROM public.drafts WHERE league_id = p_league_id AND NOT is_mock
    AND league_season_id = (result->'context'->>'seasonId')::uuid
    AND (status IN ('pending', 'in_progress', 'paused') OR (draft_type = 'snake' AND status = 'completed'))
    ORDER BY CASE WHEN status IN ('in_progress', 'paused') THEN 0 WHEN status = 'pending' THEN 1 ELSE 2 END, created_at DESC LIMIT 1;
  RETURN result || jsonb_build_object('activeDraft', CASE WHEN active IS NOT NULL THEN
    public.view_draft_room(p_league_id, p_member_id, p_params || jsonb_build_object('draftId', active))->'draft' END);
END;
$$;
