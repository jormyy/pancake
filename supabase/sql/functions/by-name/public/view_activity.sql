-- Canonical SQL source for public.view_activity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
    'tradeFaab', CASE WHEN feed.transaction_type='trade_completed' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind','faab','amount',item.faab_amount,
        'fromMemberId',item.from_member_id,'toMemberId',item.to_member_id,
        'fromTeamName',sender.team_name,'toTeamName',recipient.team_name) ORDER BY item.id)
      FROM public.league_activity activity
      JOIN public.trades trade ON trade.id=activity.related_trade_id AND trade.league_id=activity.league_id
        AND trade.status='completed' AND trade.completed_at IS NOT NULL
      JOIN public.trade_items item ON item.trade_id=trade.id AND item.league_id=trade.league_id AND item.faab_amount>0
      JOIN public.league_members sender ON sender.id=item.from_member_id AND sender.league_id=trade.league_id
      JOIN public.league_members recipient ON recipient.id=item.to_member_id AND recipient.league_id=trade.league_id
      WHERE activity.id=feed.id AND activity.league_id=p_league_id), '[]'::jsonb) ELSE '[]'::jsonb END,
    'tradePicks', feed.trade_picks, 'tradePlayers', CASE WHEN feed.transaction_type='trade_completed' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind','player','playerId',traded.id,'playerName',traded.display_name,
        'nbaId',traded.nba_id,'position',traded.position,'eligiblePositions',traded.eligible_positions,
        'nbaTeam',traded.nba_team,'injuryStatus',traded.injury_status,'yearsExp',traded.years_exp,
        'careerGames',traded.career_regular_season_games,
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
