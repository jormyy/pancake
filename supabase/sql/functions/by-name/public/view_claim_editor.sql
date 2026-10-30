-- Canonical SQL source for public.view_claim_editor.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_claim_editor(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; roster jsonb; support jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  IF p_params->>'playerId' IS NULL THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
  roster := public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId');
  SELECT jsonb_set(roster, '{roster}', COALESCE(jsonb_agg(row_data || jsonb_build_object('assetLocks',
    COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(row_data->'assetLocks') lock
      WHERE lock->>'sourceKind'<>'claim' OR lock->>'sourceId' IS DISTINCT FROM p_params->>'claimId'), '[]'::jsonb))), '[]'::jsonb))
    INTO roster FROM jsonb_array_elements(roster->'roster') row_data;
  support := public.view_players(p_league_id, p_member_id, p_params || jsonb_build_object('includePlayerIds',
    jsonb_build_array(p_params->>'playerId'), 'limit', 1));
  RETURN jsonb_build_object('context', context, 'player', (public.view_player(p_league_id, p_member_id, p_params)->'player'), 'roster', roster->'roster',
    'claims', roster->'claims', 'transactionState', roster->'transactionState', 'waiverPriority', roster->'waiverPriority',
    'waiverClearsAt', support->'waiverClearsAt', 'ownedMap', support->'ownedMap', 'slotPlan', roster->'slotPlan',
    'priority', roster->'waiverPriority', 'clearsAt', support->'waiverClearsAt'->(p_params->>'playerId'),
    'taxiExitIds', roster->'taxiExitPlayerIds', 'members', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', member.id, 'user_id', member.user_id, 'team_name', member.team_name, 'role', member.role))
      FROM public.league_members member WHERE member.league_id = p_league_id), '[]'));
END;
$$;
