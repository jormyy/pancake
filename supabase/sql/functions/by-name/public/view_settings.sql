CREATE OR REPLACE FUNCTION public.view_settings(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; priority jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', member.id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'displayName', COALESCE(profile.display_name, profile.username, '—'), 'priority', priority.priority) ORDER BY priority.priority), '[]')
  INTO priority FROM public.waiver_priorities priority JOIN public.league_members member ON member.id = priority.member_id
    LEFT JOIN public.profiles profile ON profile.id = member.user_id
  WHERE priority.league_id = p_league_id AND priority.league_season_id = (context->>'seasonId')::uuid AND (context->'season'->>'is_current')::boolean;
  RETURN jsonb_build_object('context', context, 'league', context->'league', 'waiverOrder', priority,
    'slotTemplates', COALESCE((SELECT jsonb_agg(to_jsonb(template)) FROM public.lineup_slot_templates template WHERE league_id = p_league_id), '[]'));
END;
$$;
