CREATE OR REPLACE FUNCTION public.view_standings(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; rows jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', member.id, 'teamName', COALESCE(member.team_name, 'Team'),
    'wins', COALESCE(c.wins, 0), 'losses', COALESCE(c.losses, 0), 'ties', COALESCE(c.ties, 0),
    'pointsFor', COALESCE(c.points_for, 0), 'pointsAgainst', COALESCE(c.points_against, 0), 'maxPointsFor', COALESCE(c.max_points_for, 0))
    ORDER BY (COALESCE(c.wins, 0) + 0.5 * COALESCE(c.ties, 0)) / GREATEST(COALESCE(c.wins + c.losses + c.ties, 0), 1) DESC,
      COALESCE(c.points_for, 0) / GREATEST(COALESCE(c.wins + c.losses + c.ties, 0), 1) DESC,
      COALESCE(c.max_points_for, 0) DESC, COALESCE(c.points_against, 0), COALESCE(member.team_name, 'Team') COLLATE "en-US-x-icu", member.id), '[]')
  INTO rows FROM public.league_members member LEFT JOIN public.standings_current c ON c.member_id = member.id
    AND c.league_season_id = (context->>'seasonId')::uuid AND (context->'season'->>'is_current')::boolean
  WHERE member.league_id = p_league_id;
  RETURN jsonb_build_object('context', context, 'standings', rows);
END;
$$;
