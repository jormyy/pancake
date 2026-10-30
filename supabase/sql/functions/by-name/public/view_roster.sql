-- Canonical SQL source for public.view_roster.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_roster(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET plan_cache_mode = force_generic_plan AS $$
DECLARE asset_locks jsonb; context jsonb; roster jsonb; averages jsonb; stats jsonb; slots jsonb; assignments jsonb; picks jsonb;
  target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id); transaction_state jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetKind',asset_kind,'assetId',asset_id,
    'sourceKind',source_kind,'sourceId',source_id,'reason',reason) ORDER BY source_kind,source_id), '[]'::jsonb)
    INTO asset_locks FROM private.locked_assets(p_league_id,(context->>'seasonId')::uuid,p_member_id)
    WHERE target=p_member_id;
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This roster is not available.' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='player' AND lock->>'assetId'=p.id::text),'[]'), 'id', r.id, 'is_on_ir', r.is_on_ir, 'is_on_taxi', r.is_on_taxi,
    'taxi_start_season_year', r.taxi_start_season_year, 'acquired_via', r.acquired_via, 'players', jsonb_build_object(
      'id', p.id, 'display_name', p.display_name, 'nba_team', p.nba_team, 'position', p.position,
      'eligible_positions', p.eligible_positions, 'injury_status', p.injury_status, 'nba_id', p.nba_id,
      'nba_draft_number', p.nba_draft_number, 'birthdate', p.birthdate, 'years_exp', p.years_exp, 'career_regular_season_games', p.career_regular_season_games))
      ORDER BY r.is_on_taxi, r.is_on_ir), '[]'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points))
      FILTER (WHERE COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points) IS NOT NULL), '{}'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.averages, to_jsonb(source_average)))
      FILTER (WHERE COALESCE(average.averages, to_jsonb(source_average)) IS NOT NULL), '{}')
  INTO roster, averages, stats FROM public.roster_players r JOIN public.players p ON p.id = r.player_id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = p.id
      AND average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = p.id
      AND source_average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN LATERAL (
      SELECT fantasy.avg_fantasy_points FROM public.v_player_avg_fantasy_points fantasy
      WHERE average.player_id IS NULL AND fantasy.league_id=p_league_id
        AND fantasy.player_id=p.id AND fantasy.season_year=COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
      OFFSET 0
    ) source_fantasy ON true
  WHERE r.member_id = target AND r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid;
  picks := COALESCE((SELECT jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='pick' AND lock->>'assetId'=pick->>'id'),'[]'), 'kind', 'pick', 'pickId', pick->'id', 'seasonYear', pick->'seasonYear',
      'round', pick->'round', 'originalTeamName', pick->'originalTeamName')) FROM jsonb_array_elements(
      public.view_picks(p_league_id, p_member_id, p_params || jsonb_build_object('targetMemberId', target))->'picks') pick), '[]');
  IF COALESCE((p_params->>'inventoryOnly')::boolean, false) THEN
    RETURN jsonb_build_object('roster', roster, 'picks', picks, 'avgMap', averages, 'avgStatsMap', stats);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('slotType', slot_type, 'slotCount', slot_count)), '[]') INTO slots
    FROM public.lineup_slot_templates WHERE league_id = p_league_id;
  SELECT COALESCE(jsonb_object_agg(player_id::text, slot_type), '{}') INTO assignments FROM public.weekly_lineups
    WHERE league_id = p_league_id AND member_id = target AND league_season_id = (context->>'seasonId')::uuid
      AND game_date = COALESCE((p_params->>'date')::date, (context->>'today')::date);
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('tradeLockedAssets', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock
    WHERE lock->>'sourceKind'<>'trade' OR EXISTS(SELECT 1 FROM public.trades trade
      WHERE trade.id=(lock->>'sourceId')::uuid AND trade.status='accepted')),'[]'::jsonb), 'lockedAssets', asset_locks, 'context', context, 'roster', roster,
    'picks', picks,
    'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims', 'avgMap', averages, 'avgStatsMap', stats,
    'waiverPriority', (SELECT priority FROM public.waiver_priorities WHERE member_id = p_member_id AND league_season_id = (context->>'seasonId')::uuid),
    'faabBalance', CASE WHEN context->'league'->>'waiver_mode' = 'faab' THEN transaction_state->'faabBalance' END, 'transactionState', transaction_state,
    'slotPlan', jsonb_build_object('slots', slots, 'assignments', assignments),
    'taxiExitPlayerIds', COALESCE((SELECT jsonb_agg(player_id ORDER BY player_id) FROM public.league_member_taxi_exits
      WHERE member_id = target AND league_id = p_league_id), '[]'));
END;
$$;
