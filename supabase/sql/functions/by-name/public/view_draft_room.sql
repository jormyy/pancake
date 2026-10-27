CREATE OR REPLACE FUNCTION public.view_draft_room(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; draft public.drafts%ROWTYPE; orders jsonb; budgets jsonb; nominations jsonb; picks jsonb;
  open_nomination jsonb; active_bids jsonb; current_member uuid; prospects jsonb; search_results jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO draft FROM public.drafts WHERE id = (p_params->>'draftId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'draft', NULL); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('position', entry.position, 'memberId', entry.member_id,
    'teamName', COALESCE(member.team_name, 'Unknown')) ORDER BY entry.position), '[]') INTO orders
    FROM public.draft_orders entry LEFT JOIN public.league_members member ON member.id = entry.member_id WHERE entry.draft_id = draft.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', budget.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'remaining', budget.remaining, 'initialBudget', budget.initial_budget) ORDER BY entry.position), '[]') INTO budgets
    FROM public.draft_budgets budget LEFT JOIN public.league_members member ON member.id = budget.member_id
      LEFT JOIN public.draft_orders entry ON entry.draft_id = budget.draft_id AND entry.member_id = budget.member_id WHERE budget.draft_id = draft.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', nomination.id, 'status', nomination.status,
    'nominatingMemberId', nomination.nominating_member_id, 'currentBidAmount', nomination.current_bid_amount,
    'currentBidderId', nomination.current_bidder_id, 'currentBidToTaxi', nomination.current_bid_to_taxi,
    'countdownExpiresAt', nomination.countdown_expires_at, 'winningMemberId', nomination.winning_member_id,
    'finalPrice', nomination.final_price, 'nominatedAt', nomination.nominated_at, 'nominationOrder', nomination.nomination_order,
    'player', jsonb_build_object('displayName', COALESCE(player.display_name, 'Unknown'), 'nbaTeam', player.nba_team,
      'position', player.position, 'nbaId', player.nba_id, 'yearsExp', player.years_exp,
      'careerGames', player.career_regular_season_games, 'injuryStatus', player.injury_status,
      'age', (SELECT age FROM public.dynasty_rankings WHERE player_id = player.id AND age IS NOT NULL ORDER BY fetched_at DESC NULLS LAST LIMIT 1)))
    ORDER BY nomination.nomination_order, nomination.id), '[]') INTO nominations
  FROM (SELECT * FROM public.nominations WHERE draft_id = draft.id ORDER BY nomination_order DESC LIMIT 500) nomination
    LEFT JOIN public.players player ON player.id = nomination.player_id;
  SELECT item INTO open_nomination FROM jsonb_array_elements(nominations) item WHERE item->>'status' = 'open' LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', bid.id, 'nominationId', bid.nomination_id, 'memberId', bid.member_id,
    'teamName', COALESCE(member.team_name, 'Unknown'), 'amount', bid.amount, 'placedAt', bid.placed_at)
    ORDER BY bid.placed_at DESC, bid.id), '[]') INTO active_bids
  FROM (SELECT * FROM public.bids WHERE nomination_id = (open_nomination->>'id')::uuid ORDER BY placed_at DESC LIMIT 100) bid
    LEFT JOIN public.league_members member ON member.id = bid.member_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('overallPick', pick.overall_pick, 'round', pick.round, 'pickInRound', pick.pick_in_round,
    'memberId', pick.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'), 'pickedAt', pick.picked_at,
    'skippedAt', pick.skipped_at, 'skipReason', pick.skip_reason, 'timerExpiresAt', pick.timer_expires_at,
    'player', CASE WHEN player.id IS NOT NULL THEN jsonb_build_object('id', player.id, 'displayName', COALESCE(player.display_name, 'Unknown'),
      'nbaTeam', player.nba_team, 'position', player.position, 'nbaId', player.nba_id, 'yearsExp', player.years_exp,
      'careerGames', player.career_regular_season_games, 'injuryStatus', player.injury_status) END) ORDER BY pick.overall_pick), '[]') INTO picks
    FROM public.snake_draft_picks pick LEFT JOIN public.league_members member ON member.id = pick.member_id
      LEFT JOIN public.players player ON player.id = pick.player_id WHERE pick.draft_id = draft.id;
  IF jsonb_array_length(orders) > 0 THEN current_member := (orders->((draft.current_nomination_order - 1) % jsonb_array_length(orders))->>'memberId')::uuid; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(player) ORDER BY player.nba_draft_number, player.id), '[]') INTO prospects
    FROM (SELECT id, display_name, nba_team, position, nba_id, injury_status, nba_draft_number, years_exp, career_regular_season_games
      FROM public.players WHERE nba_draft_number IS NOT NULL AND years_exp = 0
        AND (COALESCE(p_params->>'query', '') = '' OR display_name ILIKE '%' || (p_params->>'query') || '%')
      ORDER BY nba_draft_number, id LIMIT 100) player
    WHERE NOT EXISTS (SELECT 1 FROM public.snake_draft_picks WHERE draft_id = draft.id AND player_id = player.id);
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || jsonb_build_object('age', (SELECT age FROM public.dynasty_rankings
    WHERE player_id = player.id AND age IS NOT NULL ORDER BY fetched_at DESC NULLS LAST LIMIT 1)) ORDER BY ordinal), '[]') INTO search_results
    FROM (SELECT p.id, p.display_name, p.nba_team, p.position, p.nba_id, p.injury_status, p.years_exp,
      p.career_regular_season_games, p.dynasty_rank, p.dynasty_rank_source, p.dynasty_rank_fetched_at,
      row_number() OVER (ORDER BY CASE WHEN draft.nomination_order_mode <> 'alphabetical' THEN p.dynasty_rank END NULLS LAST, p.last_name, p.display_name, p.id) AS ordinal
      FROM public.players p WHERE NOT EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = draft.id AND player_id = p.id)
        AND (COALESCE(p_params->>'query', '') = '' OR p.display_name ILIKE '%' || (p_params->>'query') || '%')
      ORDER BY ordinal LIMIT 20) player;
  RETURN jsonb_build_object('context', context, 'draft', jsonb_build_object('id', draft.id, 'leagueId', draft.league_id,
    'leagueSeasonId', draft.league_season_id, 'seasonYear', (SELECT season_year FROM public.league_seasons WHERE id = draft.league_season_id),
    'isCurrentSeason', COALESCE((SELECT is_current FROM public.league_seasons WHERE id = draft.league_season_id), false),
    'status', draft.status, 'draftType', draft.draft_type, 'isMock', draft.is_mock, 'currentNominationOrder', draft.current_nomination_order,
    'nominationOrderMode', draft.nomination_order_mode, 'budgetPerTeam', draft.budget_per_team, 'scheduledAt', draft.scheduled_at,
    'roomName', draft.room_name, 'createdByMemberId', draft.created_by_member_id, 'pickTimerSeconds', draft.pick_timer_seconds,
    'timerExpiryBehavior', draft.timer_expiry_behavior, 'rounds', draft.rounds, 'startedAt', draft.started_at, 'completedAt', draft.completed_at,
    'pauseReason', draft.pause_reason, 'pausedAt', draft.paused_at, 'pausedRemainingSeconds', draft.timer_paused_remaining_seconds),
    'order', orders, 'orders', orders, 'budgets', budgets, 'nominations', nominations, 'openNomination', open_nomination,
    'activeBids', active_bids, 'currentNominatorMemberId', current_member, 'picks', picks,
    'prospects', prospects, 'searchResults', search_results,
    'nextPick', (SELECT item FROM jsonb_array_elements(picks) item WHERE item->>'player' IS NULL AND item->>'skippedAt' IS NULL LIMIT 1));
END;
$$;
