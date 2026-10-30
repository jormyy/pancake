-- Canonical SQL source for public.view_draft_rooms.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_draft_rooms(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; rooms jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', draft.id, 'leagueId', draft.league_id, 'draftType', draft.draft_type,
    'status', draft.status, 'roomStatus', CASE WHEN draft.status IN ('in_progress', 'paused') THEN 'live'
      WHEN draft.status IN ('completed', 'cancelled') THEN 'completed' WHEN draft.scheduled_at > now() THEN 'scheduled' ELSE 'active' END,
    'roomName', COALESCE(NULLIF(trim(draft.room_name), ''), CASE WHEN draft.draft_type = 'snake' THEN 'Mock Rookie Draft' ELSE 'Mock Auction' END),
    'scheduledAt', draft.scheduled_at, 'startedAt', draft.started_at, 'completedAt', draft.completed_at,
    'createdByMemberId', draft.created_by_member_id, 'creatorTeamName', COALESCE(creator.team_name, 'Team'),
    'pickTimerSeconds', draft.pick_timer_seconds, 'rounds', draft.rounds, 'nominationOrderMode', draft.nomination_order_mode,
    'timerExpiryBehavior', draft.timer_expiry_behavior, 'participants', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'memberId', participant.member_id, 'teamName', COALESCE(member.team_name, 'Team'), 'joinedAt', participant.joined_at)
      ORDER BY participant.joined_at, participant.member_id) FROM public.draft_room_members participant
      LEFT JOIN public.league_members member ON member.id = participant.member_id WHERE participant.draft_id = draft.id), '[]'),
    'isJoined', EXISTS (SELECT 1 FROM public.draft_room_members WHERE draft_id = draft.id AND member_id = p_member_id),
    'isCreator', COALESCE(draft.created_by_member_id = p_member_id, false)) ORDER BY draft.created_at DESC, draft.id), '[]')
  INTO rooms FROM (SELECT * FROM public.drafts WHERE league_id = p_league_id AND is_mock ORDER BY created_at DESC, id LIMIT 60) draft
    LEFT JOIN public.league_members creator ON creator.id = draft.created_by_member_id;
  RETURN jsonb_build_object('context', context, 'rooms', rooms,
    'drafts', COALESCE((SELECT jsonb_agg(to_jsonb(draft) ORDER BY draft.created_at DESC, draft.id)
      FROM public.drafts draft WHERE league_id = p_league_id AND NOT is_mock AND league_season_id = (context->>'seasonId')::uuid), '[]'));
END;
$$;
