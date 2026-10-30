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
    'tradePicks', feed.trade_picks)), '[]')
  INTO rows FROM public.get_league_activity_feed(p_league_id, page_size, GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0)) feed
    LEFT JOIN public.players player ON player.id = feed.player_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(announcement) ORDER BY announcement.published_at DESC), '[]') INTO announcements
    FROM public.notif_list_announcements(p_league_id) announcement;
  RETURN jsonb_build_object('context', context, 'rows', rows, 'announcements', announcements,
    'hasMore', jsonb_array_length(rows) = page_size, 'offset', GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0) + jsonb_array_length(rows));
END;
$$;
