CREATE OR REPLACE FUNCTION public.view_claims(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; claims jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  WITH selected AS (
    (SELECT claim.* FROM public.waiver_claims claim WHERE claim.league_id = p_league_id AND claim.member_id = p_member_id
      AND claim.league_season_id = (context->>'seasonId')::uuid AND claim.status = 'pending'
      ORDER BY claim.claim_order, claim.submitted_at)
    UNION ALL
    (SELECT claim.* FROM public.waiver_claims claim WHERE claim.league_id = p_league_id AND claim.member_id = p_member_id
      AND claim.league_season_id = (context->>'seasonId')::uuid AND claim.status IN ('succeeded', 'failed_priority', 'failed_roster')
      ORDER BY claim.submitted_at DESC LIMIT 20)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(jsonb_build_object('assetKind', locked.asset_kind, 'assetId', locked.asset_id, 'sourceKind', locked.source_kind, 'sourceId', locked.source_id, 'reason', locked.reason)) FROM private.locked_assets(p_league_id, (context->>'seasonId')::uuid, p_member_id) locked WHERE locked.source_kind='claim' AND locked.source_id=claim.id), '[]'), 'id', claim.id, 'playerId', claim.player_id,
    'clearsAt', CASE WHEN claim.status = 'pending' THEN (SELECT max(log.clears_at) FROM public.waiver_wire_log log
      WHERE log.player_id = claim.player_id AND log.league_id = p_league_id AND log.league_season_id = claim.league_season_id AND log.cleared_at IS NULL AND log.clears_at > now()) END,
    'playerName', COALESCE(player.display_name, 'Unknown'), 'playerNbaId', player.nba_id,
    'dropPlayerId', claim.drop_player_id, 'dropPlayerName', dropped.display_name, 'dropPlayerNbaId', dropped.nba_id,
    'status', claim.status, 'submittedAt', claim.submitted_at, 'processDate', claim.process_date,
    'priorityAtSubmission', claim.priority_at_submission, 'bidAmount', claim.bid_amount, 'claimOrder', claim.claim_order,
    'toIr', claim.to_ir, 'toTaxi', claim.to_taxi, 'playerTeam', player.nba_team, 'playerPosition', player.position,
    'playerInjuryStatus', player.injury_status, 'playerYearsExp', player.years_exp,
    'playerCareerGames', player.career_regular_season_games, 'failureReason', claim.failure_reason)
    ORDER BY claim.status <> 'pending', CASE WHEN claim.status = 'pending' THEN claim.claim_order END,
      CASE WHEN claim.status = 'pending' THEN claim.submitted_at END, claim.submitted_at DESC, claim.id), '[]')
  INTO claims FROM selected claim LEFT JOIN public.players player ON player.id = claim.player_id
    LEFT JOIN public.players dropped ON dropped.id = claim.drop_player_id
  WHERE (context->'season'->>'is_current')::boolean;
  RETURN jsonb_build_object('context', context, 'claims', claims);
END;
$$;
