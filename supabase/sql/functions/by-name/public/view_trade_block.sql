-- Canonical SQL source for public.view_trade_block.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_trade_block(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; items jsonb; roster jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', item.id, 'memberId', item.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'note', item.note, 'updatedAt', item.updated_at, 'rosterLocation', CASE WHEN roster.id IS NOT NULL THEN
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END END,
    'asset', CASE WHEN player.id IS NOT NULL THEN jsonb_build_object('kind', 'player', 'playerId', player.id,
      'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position, 'eligiblePositions', player.eligible_positions,
      'nbaTeam', player.nba_team, 'nbaId', player.nba_id, 'injuryStatus', player.injury_status,
      'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number, 'careerGames', player.career_regular_season_games,
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    ELSE jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown')) END) ORDER BY item.updated_at DESC, item.id), '[]')
  INTO items FROM public.trade_block_items item JOIN public.league_members member ON member.id = item.member_id
    LEFT JOIN public.players player ON player.id = item.player_id LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id
    LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.roster_players roster ON roster.player_id = item.player_id AND roster.member_id = item.member_id
      AND roster.league_season_id = (context->>'seasonId')::uuid
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = public.current_season_year_et()
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = public.current_season_year_et()
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = public.current_season_year_et()
  WHERE item.league_id = p_league_id AND (context->'season'->>'is_current')::boolean AND (player.id IS NOT NULL OR pick.id IS NOT NULL);
  IF COALESCE((p_params->>'blockOnly')::boolean, false) THEN
    RETURN jsonb_build_object('block', items);
  END IF;
  roster := public.view_roster(p_league_id, p_member_id, (p_params - 'targetMemberId') || jsonb_build_object('inventoryOnly', true));
  RETURN jsonb_build_object('context', context, 'block', items, 'items', items, 'roster', roster->'roster', 'picks', roster->'picks',
    'avgMap', roster->'avgMap', 'avgStatsMap', roster->'avgStatsMap');
END;
$$;
