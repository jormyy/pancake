-- Canonical SQL source for public.get_trade_cards.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_trade_cards(p_league_id uuid,p_member_id uuid,p_trade_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE cards jsonb; current_year integer:=public.current_season_year_et(); teams integer;
BEGIN
  PERFORM public.view_context(p_league_id,p_member_id);
  IF p_trade_ids IS NULL OR cardinality(p_trade_ids)>100 THEN
    RAISE EXCEPTION 'Choose at most 100 trades.' USING ERRCODE='22023';
  END IF;
  IF cardinality(p_trade_ids)=0 THEN RETURN '[]'::jsonb; END IF;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=p_league_id;
  WITH own_members AS MATERIALIZED (
    SELECT id FROM public.league_members WHERE league_id=p_league_id AND user_id=auth.uid()
  ), requested AS MATERIALIZED (
    SELECT id,ordinal FROM unnest(p_trade_ids) WITH ORDINALITY row(id,ordinal)
  ), chosen AS MATERIALIZED (
    SELECT trade.* FROM public.trades trade WHERE trade.league_id=p_league_id AND trade.id=ANY(p_trade_ids)
      AND (trade.status='accepted' OR trade.proposer_member_id IN(SELECT id FROM own_members)
        OR trade.recipient_member_id IN(SELECT id FROM own_members)
        OR EXISTS(SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id=trade.id
          AND participant.member_id IN(SELECT id FROM own_members)))
  ), participants AS (
    SELECT participant.trade_id,COALESCE(jsonb_agg(jsonb_build_object('memberId',participant.member_id,
      'teamName',COALESCE(member.team_name,'Unknown'),'sortOrder',participant.sort_order,
      'isInitiator',participant.is_initiator,'acceptedAt',participant.accepted_at,
      'dropPlayerIds',participant.drop_player_ids,'rosterMoves',participant.roster_moves)
      ORDER BY participant.sort_order,member.team_name,participant.member_id),'[]') AS value
    FROM chosen trade JOIN public.trade_participants participant ON participant.trade_id=trade.id
    LEFT JOIN public.league_members member ON member.id=participant.member_id AND member.league_id=p_league_id
    GROUP BY participant.trade_id
  ), pick_values AS MATERIALIZED (
    SELECT value.* FROM public.get_dynasty_pick_values(p_league_id) value
    WHERE EXISTS(SELECT 1 FROM chosen trade JOIN public.trade_items item ON item.trade_id=trade.id
      JOIN public.draft_picks pick ON pick.id=item.pick_id WHERE pick.predicted_trade_value IS NULL)
  ), items AS (
    SELECT item.trade_id, COALESCE(jsonb_agg(CASE WHEN item.player_id IS NOT NULL THEN jsonb_build_object('kind', 'player',
      'tradeValue', (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1),
      'playerId', player.id, 'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position,
      'eligiblePositions', player.eligible_positions, 'nbaTeam', player.nba_team, 'nbaId', player.nba_id,
      'injuryStatus', player.injury_status, 'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number,
      'careerGames', player.career_regular_season_games, 'toTaxi', item.to_taxi, 'toIR', item.to_ir,
      'fromTaxi', EXISTS (SELECT 1 FROM public.roster_players r WHERE r.player_id = player.id AND r.member_id = item.from_member_id
        AND r.league_season_id = trade.league_season_id AND r.is_on_taxi),
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    WHEN item.pick_id IS NOT NULL THEN jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'tradeValue', COALESCE(pick.predicted_trade_value,(SELECT value.trade_value FROM pick_values value
        WHERE value.draft_year=pick.season_year-1 AND value.round=pick.round AND value.tier=CASE
          WHEN slot.pick_in_round IS NULL THEN 'mid'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)/3.0) THEN 'early'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)*2/3.0) THEN 'mid'
          ELSE 'late' END)),
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown'))
    ELSE jsonb_build_object('kind', 'faab', 'amount', item.faab_amount) END
    || jsonb_build_object('fromMemberId', item.from_member_id, 'toMemberId', item.to_member_id) ORDER BY item.id), '[]')
    AS value FROM public.trade_items item JOIN chosen trade ON trade.id=item.trade_id LEFT JOIN public.players player ON player.id = item.player_id
    LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id AND pick.league_id=p_league_id LEFT JOIN public.league_members original ON original.id = pick.original_owner_id AND original.league_id=p_league_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = current_year
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = current_year
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = current_year
    GROUP BY item.trade_id

  )
  SELECT COALESCE(jsonb_agg(CASE WHEN trade.id IS NOT NULL THEN jsonb_build_object('id', trade.id, 'status', trade.status, 'completionFailureReason', trade.completion_failure_reason,
    'proposedAt', trade.proposed_at, 'acceptedAt', trade.accepted_at, 'vetoWindowExpiresAt', trade.veto_window_expires_at,
    'completedAt', trade.completed_at, 'vetoedAt', trade.vetoed_at, 'expiresAt', trade.expires_at, 'notes', trade.notes,
    'proposerMemberId', trade.proposer_member_id, 'proposerTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.proposer_member_id), 'Unknown'),
    'recipientMemberId', trade.recipient_member_id, 'recipientTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.recipient_member_id), 'Unknown'),
    'isMultiTeam', trade.is_multi_team, 'participants', COALESCE(participants.value,'[]'::jsonb), 'parentTradeId', trade.parent_trade_id,
    'counteredFromTradeId', trade.countered_from_trade_id, 'editedFromTradeId', trade.edited_from_trade_id, 'replacedByTradeId', trade.replaced_by_trade_id,
    'version', trade.version, 'proposerFaabAmount', trade.proposer_faab_amount, 'recipientFaabAmount', trade.recipient_faab_amount,
    'myVetoed', EXISTS (SELECT 1 FROM public.trade_vetos WHERE trade_id = trade.id AND member_id = p_member_id),
    'routedItems', COALESCE(items.value,'[]'::jsonb), 'estimate', CASE WHEN quote.id IS NOT NULL OR cached.trade_id IS NOT NULL THEN jsonb_build_object('quoteId',quote.id,'modelVersion',COALESCE(cached.revaluation->>'modelVersion',quote.model_version),'inputVersion',COALESCE(cached.revaluation->>'inputVersion',quote.input_version),'createdAt',COALESCE(cached.revaluation->>'createdAt',quote.created_at::text),'teams',COALESCE(cached.revaluation->'analysis'->'teams',quote.analysis->'teams'),'assets',COALESCE(cached.revaluation->'analysis'->'assets',quote.analysis->'assets')) END, 'estimateUnavailable', recorded.unavailable_reason) END ORDER BY requested.ordinal),'[]')
  INTO cards FROM requested LEFT JOIN chosen trade ON trade.id=requested.id
    LEFT JOIN participants ON participants.trade_id=trade.id LEFT JOIN items ON items.trade_id=trade.id
    LEFT JOIN public.trade_estimates recorded ON recorded.trade_id=trade.id
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id=recorded.quote_id
    LEFT JOIN public.trade_value_cache cached ON cached.trade_id=trade.id AND cached.revaluation->>'modelVersion'='onenumber-trade-curve-v5';
  RETURN cards;
END;
$$;
