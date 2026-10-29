CREATE OR REPLACE FUNCTION public.view_picks(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; picks jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pick.id, 'seasonYear', pick.season_year, 'round', pick.round,
    'isUsed', pick.is_used, 'originalOwnerMemberId', pick.original_owner_id, 'originalTeamName', COALESCE(original.team_name, 'Unknown'),
    'currentOwnerMemberId', pick.current_owner_id, 'currentTeamName', COALESCE(owner.team_name, 'Unknown')) ORDER BY pick.season_year, pick.round, pick.id), '[]')
  INTO picks FROM public.draft_picks pick LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.league_members owner ON owner.id = pick.current_owner_id
  WHERE pick.league_id = p_league_id AND NOT pick.is_used
    AND pick.season_year BETWEEN (context->'season'->>'season_year')::int
      AND (context->'season'->>'season_year')::int + (context->'league'->>'future_pick_years')::int
    AND (p_params->>'targetMemberId' IS NULL OR pick.current_owner_id = (p_params->>'targetMemberId')::uuid);
  RETURN jsonb_build_object('context', context, 'picks', picks);
END;
$$;
