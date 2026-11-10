BEGIN;

CREATE OR REPLACE FUNCTION public.view_trade_block(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; items jsonb; roster jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', item.id, 'memberId', item.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'note', item.note, 'updatedAt', item.updated_at, 'rosterLocation', CASE WHEN roster.id IS NOT NULL THEN
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END END,
    'asset', CASE WHEN player.id IS NOT NULL THEN jsonb_build_object('kind', 'player', 'playerId', player.id,
      'tradeValue', (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1),
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
    LEFT JOIN LATERAL (
      SELECT fantasy.avg_fantasy_points FROM public.v_player_avg_fantasy_points fantasy
      WHERE average.player_id IS NULL AND fantasy.league_id=p_league_id
        AND fantasy.player_id=item.player_id AND fantasy.season_year=public.current_season_year_et()
      OFFSET 0
    ) source_fantasy ON true
  WHERE item.league_id = p_league_id AND (context->'season'->>'is_current')::boolean AND (player.id IS NOT NULL OR pick.id IS NOT NULL);
  IF COALESCE((p_params->>'blockOnly')::boolean, false) THEN
    RETURN jsonb_build_object('block', items);
  END IF;
  roster := public.view_roster(p_league_id, p_member_id, (p_params - 'targetMemberId') || jsonb_build_object('inventoryOnly', true));
  RETURN jsonb_build_object('context', context, 'block', items, 'items', items, 'roster', (SELECT COALESCE(jsonb_agg(entry || jsonb_build_object('tradeValue',
      (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=(entry->'players'->>'id')::uuid
        AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1)) ORDER BY ordinal), '[]'::jsonb)
      FROM jsonb_array_elements(roster->'roster') WITH ORDINALITY row(entry,ordinal)), 'picks', roster->'picks',
    'avgMap', roster->'avgMap', 'avgStatsMap', roster->'avgStatsMap');
END;
$$;

CREATE OR REPLACE FUNCTION public.view_activity(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; rows jsonb; announcements jsonb; page_size integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 50), 1), 100);
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', feed.id, 'memberId', feed.member_id, 'targetMemberId', feed.target_member_id,
    'teamName', COALESCE(feed.team_name, CASE WHEN feed.is_system THEN 'League' ELSE 'Unknown' END), 'targetTeamName', feed.target_team_name,
    'playerId', feed.player_id, 'playerName', COALESCE(feed.player_name, feed.title, 'Unknown'), 'position', feed.player_position,
    'eligiblePositions', COALESCE(to_jsonb(feed.eligible_positions), CASE WHEN feed.player_position IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(feed.player_position) END),
    'nbaId', feed.nba_id, 'nbaTeam', player.nba_team, 'injuryStatus', player.injury_status, 'yearsExp', player.years_exp,
    'careerGames', player.career_regular_season_games, 'transactionType', feed.transaction_type, 'occurredAt', feed.occurred_at,
    'playerMentions', feed.player_mentions, 'isSystem', feed.is_system, 'title', feed.title, 'body', feed.body, 'participantTeamNames', feed.participant_team_names,
    'tradePicks', feed.trade_picks, 'tradePlayers', CASE WHEN feed.transaction_type='trade_completed' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind','player','playerId',traded.id,'playerName',traded.display_name,
        'tradeValue',(SELECT ranking.trade_value FROM public.dynasty_rankings ranking
          WHERE ranking.player_id=traded.id AND ranking.source='onenumberhoops.com'
          ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1),
        'fromMemberId',item.from_member_id,'toMemberId',item.to_member_id,
        'fromTeamName',sender.team_name,'toTeamName',recipient.team_name) ORDER BY item.id)
      FROM public.league_activity activity
      JOIN public.trades trade ON trade.id=activity.related_trade_id AND trade.league_id=activity.league_id
        AND trade.status='completed' AND trade.completed_at IS NOT NULL
      JOIN public.trade_items item ON item.trade_id=trade.id AND item.league_id=trade.league_id
      JOIN public.players traded ON traded.id=item.player_id
      JOIN public.league_members sender ON sender.id=item.from_member_id AND sender.league_id=trade.league_id
      JOIN public.league_members recipient ON recipient.id=item.to_member_id AND recipient.league_id=trade.league_id
      WHERE activity.id=feed.id AND activity.league_id=p_league_id), '[]'::jsonb) ELSE '[]'::jsonb END)), '[]')
  INTO rows FROM public.get_league_activity_feed(p_league_id, page_size, GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0)) feed
    LEFT JOIN public.players player ON player.id = feed.player_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(announcement) ORDER BY announcement.published_at DESC), '[]') INTO announcements
    FROM public.notif_list_announcements(p_league_id) announcement;
  RETURN jsonb_build_object('context', context, 'rows', rows, 'announcements', announcements,
    'hasMore', jsonb_array_length(rows) = page_size, 'offset', GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0) + jsonb_array_length(rows));
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
