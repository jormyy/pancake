-- Canonical SQL source for public.view_players.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_players(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; players jsonb; ownership jsonb; waivers jsonb; pending jsonb; transaction_state jsonb;
  include_ids uuid[]; exclude_ids uuid[]; page_size integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 20), 1), 50);
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_object_agg(r.player_id::text, jsonb_build_object('teamName', COALESCE(m.team_name, 'Team'),
    'memberId', r.member_id, 'isOnIR', r.is_on_ir, 'isOnTaxi', r.is_on_taxi)), '{}') INTO ownership
    FROM public.roster_players r JOIN public.league_members m ON m.id = r.member_id
    WHERE r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid;
  SELECT COALESCE(jsonb_object_agg(player_id::text, clears_at), '{}') INTO waivers FROM (
    SELECT player_id, max(clears_at) AS clears_at FROM public.waiver_wire_log WHERE league_id = p_league_id
      AND league_season_id = (context->>'seasonId')::uuid AND cleared_at IS NULL AND clears_at > now()
      AND (context->'season'->>'is_current')::boolean GROUP BY player_id) logs;
  SELECT COALESCE(jsonb_agg(DISTINCT player_id), '[]') INTO pending FROM public.waiver_claims
    WHERE member_id = p_member_id AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
      AND status = 'pending' AND (context->'season'->>'is_current')::boolean;
  IF p_params ? 'includePlayerIds' THEN SELECT array_agg(value::uuid) INTO include_ids FROM jsonb_array_elements_text(p_params->'includePlayerIds'); END IF;
  IF p_params->>'availability' = 'rostered' THEN SELECT COALESCE(array_agg(key::uuid), '{}') INTO include_ids FROM jsonb_each(ownership);
  ELSIF p_params->>'availability' = 'mine' THEN SELECT COALESCE(array_agg(key::uuid), '{}') INTO include_ids FROM jsonb_each(ownership) WHERE value->>'memberId' = p_member_id::text;
  ELSIF p_params->>'availability' = 'waivers' THEN SELECT COALESCE(array_agg(key::uuid), '{}') INTO include_ids FROM jsonb_each(waivers);
  END IF;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO exclude_ids FROM jsonb_array_elements_text(COALESCE(p_params->'excludePlayerIds', '[]'));
  IF p_params->>'availability' IN ('available', 'free_agents') THEN
    exclude_ids := exclude_ids || ARRAY(SELECT key::uuid FROM jsonb_each(ownership));
    IF p_params->>'availability' = 'free_agents' THEN exclude_ids := exclude_ids || ARRAY(SELECT key::uuid FROM jsonb_each(waivers)); END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM public.players WHERE id = player.id))), '[]') INTO players FROM public.view_player_search(
    p_query := COALESCE(p_params->>'query', ''), p_position := COALESCE(p_params->>'position', 'ALL'),
    p_teams := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_params->'teams', '[]'))), p_league_id := p_league_id,
    p_playing_teams := CASE WHEN p_params->>'playing' = 'today' THEN ARRAY(SELECT home_team FROM public.nba_games WHERE game_date = (context->>'today')::date UNION SELECT away_team FROM public.nba_games WHERE game_date = (context->>'today')::date) WHEN p_params ? 'playingTeams' THEN ARRAY(SELECT jsonb_array_elements_text(p_params->'playingTeams')) END,
    p_excluded_teams := CASE WHEN p_params->>'playing' = 'not_today' THEN ARRAY(SELECT home_team FROM public.nba_games WHERE game_date = (context->>'today')::date UNION SELECT away_team FROM public.nba_games WHERE game_date = (context->>'today')::date) ELSE ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_params->'excludedTeams', '[]'))) END,
    p_include_player_ids := include_ids, p_exclude_player_ids := exclude_ids,
    p_rookies_only := COALESCE((p_params->>'rookiesOnly')::boolean, false), p_health := COALESCE(p_params->>'health', 'all'),
    p_sort_by := COALESCE(p_params->>'sortBy', 'fpts'), p_sort_dir := COALESCE(p_params->>'sortDir', 'desc'),
    p_season_year := (p_params->>'seasonYear')::integer, p_limit := page_size,
    p_offset := GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0)) player;
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('context', context, 'players', players, 'ownedMap',
    CASE WHEN p_params->>'availability'='free_agents' AND NOT (p_params ? 'includePlayerIds') THEN '{}'::jsonb ELSE ownership END,
    'waiverClearsAt', waivers,
    'waiverIds', COALESCE((SELECT jsonb_agg(key) FROM jsonb_each(waivers)), '[]'), 'pendingClaimIds', pending,
    'transactionState', transaction_state, 'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims',
    'hasMore', jsonb_array_length(players) = page_size, 'weekDays', public.view_lineup(p_league_id, p_member_id, p_params)->'weekDays',
    'visibleTotals', COALESCE((SELECT jsonb_agg(to_jsonb(totals)) FROM public.get_visible_player_totals(p_league_id,
      ARRAY(SELECT (player->>'id')::uuid FROM jsonb_array_elements(players) player),
      COALESCE((p_params->>'seasonYear')::integer, (players->0->>'stats_season_year')::integer, (context->>'seasonYear')::integer)) totals), '[]'));
END;
$$;
