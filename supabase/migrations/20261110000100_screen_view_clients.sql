CREATE OR REPLACE FUNCTION public.view_context(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE member public.league_members%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  today date := (now() AT TIME ZONE 'America/New_York')::date; week integer; version bigint; dirty boolean;
BEGIN
  IF jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'View parameters must be an object.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO member FROM public.league_members WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'This screen is not available.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO league FROM public.leagues WHERE id = p_league_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'This screen is not available.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO season FROM public.league_seasons WHERE league_id = p_league_id
    AND (p_params->>'seasonId' IS NULL OR id = (p_params->>'seasonId')::uuid)
    ORDER BY is_current DESC, season_year DESC LIMIT 1;
  IF p_params->>'seasonId' IS NOT NULL AND season.id IS NULL THEN RAISE EXCEPTION 'This season is not available.' USING ERRCODE = '42501'; END IF;
  SELECT week_number INTO week FROM public.season_weeks WHERE season_year = season.season_year
    ORDER BY CASE WHEN today BETWEEN week_start AND week_end THEN 0 WHEN week_start > today THEN 1 ELSE 2 END,
      CASE WHEN week_start >= today THEN week_start END, week_end DESC LIMIT 1;
  SELECT q.version, q.dirty INTO version, dirty FROM private.screen_refresh_queue q WHERE q.league_season_id = season.id;
  RETURN jsonb_build_object('leagueId', p_league_id, 'memberId', p_member_id, 'league', to_jsonb(league),
    'member', to_jsonb(member), 'season', CASE WHEN season.id IS NULL THEN NULL ELSE to_jsonb(season) END,
    'seasonId', season.id, 'seasonYear', COALESCE((p_params->>'seasonYear')::integer, season.season_year, public.current_season_year_et()),
    'weekNumber', COALESCE((p_params->>'weekNumber')::integer, week), 'today', today,
    'pendingIncomingCount', public.get_pending_trade_count(p_member_id, p_league_id),
    'version', version, 'stale', COALESCE(dirty, true));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_roster(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; roster jsonb; averages jsonb; stats jsonb; slots jsonb; assignments jsonb;
  target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id); transaction_state jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This roster is not available.' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'is_on_ir', r.is_on_ir, 'is_on_taxi', r.is_on_taxi,
    'taxi_start_season_year', r.taxi_start_season_year, 'acquired_via', r.acquired_via, 'players', jsonb_build_object(
      'id', p.id, 'display_name', p.display_name, 'nba_team', p.nba_team, 'position', p.position,
      'eligible_positions', p.eligible_positions, 'injury_status', p.injury_status, 'nba_id', p.nba_id,
      'nba_draft_number', p.nba_draft_number, 'years_exp', p.years_exp, 'career_regular_season_games', p.career_regular_season_games))
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
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = p.id AND source_fantasy.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
  WHERE r.member_id = target AND r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('slotType', slot_type, 'slotCount', slot_count)), '[]') INTO slots
    FROM public.lineup_slot_templates WHERE league_id = p_league_id;
  SELECT COALESCE(jsonb_object_agg(player_id::text, slot_type), '{}') INTO assignments FROM public.weekly_lineups
    WHERE league_id = p_league_id AND member_id = target AND league_season_id = (context->>'seasonId')::uuid
      AND game_date = COALESCE((p_params->>'date')::date, (context->>'today')::date);
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('context', context, 'roster', roster,
    'picks', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', 'pick', 'pickId', pick->'id', 'seasonYear', pick->'seasonYear',
      'round', pick->'round', 'originalTeamName', pick->'originalTeamName')) FROM jsonb_array_elements(
      public.view_picks(p_league_id, p_member_id, p_params || jsonb_build_object('targetMemberId', target))->'picks') pick), '[]'),
    'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims', 'avgMap', averages, 'avgStatsMap', stats,
    'waiverPriority', (SELECT priority FROM public.waiver_priorities WHERE member_id = p_member_id AND league_season_id = (context->>'seasonId')::uuid),
    'faabBalance', CASE WHEN context->'league'->>'waiver_mode' = 'faab' THEN transaction_state->'faabBalance' END, 'transactionState', transaction_state,
    'slotPlan', jsonb_build_object('slots', slots, 'assignments', assignments),
    'taxiExitPlayerIds', COALESCE((SELECT jsonb_agg(player_id ORDER BY player_id) FROM public.league_member_taxi_exits
      WHERE member_id = target AND league_id = p_league_id), '[]'));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_home(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; matchup public.matchups%ROWTYPE; opponent uuid; selected date;
  mine jsonb; theirs jsonb; records jsonb; matchup_data jsonb; league_matchups jsonb; announcements jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(to_jsonb(row)), '[]') INTO announcements FROM public.notif_list_announcements(p_league_id) row;
  SELECT * INTO matchup FROM public.matchups WHERE league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
    AND NOT is_voided AND p_member_id IN (home_member_id, away_member_id) AND week_number <= (context->>'weekNumber')::integer
    AND COALESCE(end_week_number, week_number) >= (context->>'weekNumber')::integer
    AND (context->'season'->>'is_current')::boolean ORDER BY week_number DESC, id LIMIT 1;
  IF matchup.id IS NULL THEN RETURN jsonb_build_object('context', context, 'matchup', NULL, 'weekDays', '[]'::jsonb,
    'leagueMatchups', '[]'::jsonb, 'myLineup', NULL, 'oppLineup', NULL, 'forecast', NULL, 'announcements', announcements,
    'todaysGames', '[]'::jsonb, 'liveStats', '{}'::jsonb, 'startedTeams', '[]'::jsonb, 'teamMatchups', '{}'::jsonb,
    'selectedDate', COALESCE(p_params->>'date', context->>'today')); END IF;
  opponent := CASE WHEN matchup.home_member_id = p_member_id THEN matchup.away_member_id ELSE matchup.home_member_id END;
  selected := COALESCE((p_params->>'date')::date, (context->>'today')::date);
  SELECT GREATEST(LEAST(selected, week_end), CASE WHEN week_number = 1 THEN date_trunc('week', week_start::timestamp)::date ELSE week_start END)
    INTO selected FROM public.season_weeks WHERE season_year = (context->>'seasonYear')::integer AND week_number = (context->>'weekNumber')::integer;
  mine := public.view_lineup(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected));
  theirs := public.view_lineup(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected, 'targetMemberId', opponent));
  records := public.view_standings(p_league_id, p_member_id, p_params)->'standings';
  SELECT jsonb_build_object('id', matchup.id, 'weekNumber', (context->>'weekNumber')::integer,
    'roundStartWeek', matchup.week_number, 'roundEndWeek', COALESCE(matchup.end_week_number, matchup.week_number),
    'myPoints', CASE WHEN matchup.home_member_id = p_member_id THEN matchup.home_points ELSE matchup.away_points END,
    'opponentPoints', CASE WHEN matchup.home_member_id = p_member_id THEN matchup.away_points ELSE matchup.home_points END,
    'myTeamName', COALESCE(member.team_name, 'My Team'), 'opponentTeamName', COALESCE(other.team_name, 'Opponent'),
    'myUsername', COALESCE(profile.display_name, ''), 'opponentUsername', COALESCE(other_profile.display_name, ''),
    'myWins', COALESCE((SELECT row->'wins' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = p_member_id::text), '0'),
    'myLosses', COALESCE((SELECT row->'losses' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = p_member_id::text), '0'),
    'opponentWins', COALESCE((SELECT row->'wins' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = opponent::text), '0'),
    'opponentLosses', COALESCE((SELECT row->'losses' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = opponent::text), '0'),
    'isFinalized', matchup.is_finalized, 'iWon', CASE WHEN matchup.winner_member_id IS NOT NULL THEN matchup.winner_member_id = p_member_id END,
    'myMemberId', p_member_id, 'opponentMemberId', opponent, 'seasonId', matchup.league_season_id, 'seasonYear', (context->>'seasonYear')::integer)
  INTO matchup_data FROM public.league_members member JOIN public.league_members other ON other.id = opponent
    LEFT JOIN public.profiles profile ON profile.id = member.user_id LEFT JOIN public.profiles other_profile ON other_profile.id = other.user_id
    LEFT JOIN public.matchup_totals totals ON totals.matchup_id = matchup.id WHERE member.id = p_member_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'homeMemberId', m.home_member_id, 'awayMemberId', m.away_member_id,
    'homeTeamName', COALESCE(home.team_name, 'Home'), 'awayTeamName', COALESCE(away.team_name, 'Away'),
    'homePoints', m.home_points, 'awayPoints', m.away_points, 'isFinalized', m.is_finalized,
    'isMine', p_member_id IN (m.home_member_id, m.away_member_id)) ORDER BY p_member_id IN (m.home_member_id, m.away_member_id) DESC,
      GREATEST(COALESCE(totals.home_points, 0), COALESCE(totals.away_points, 0)) DESC, m.id), '[]')
  INTO league_matchups FROM public.matchups m JOIN public.league_members home ON home.id = m.home_member_id
    JOIN public.league_members away ON away.id = m.away_member_id LEFT JOIN public.matchup_totals totals ON totals.matchup_id = m.id
  WHERE m.league_id = p_league_id AND m.league_season_id = matchup.league_season_id AND NOT m.is_voided
    AND m.week_number <= (context->>'weekNumber')::integer AND COALESCE(m.end_week_number, m.week_number) >= (context->>'weekNumber')::integer;
  RETURN jsonb_build_object('context', context, 'matchup', matchup_data, 'weekDays', mine->'weekDays', 'selectedDate', selected,
    'leagueMatchups', league_matchups, 'myLineup', mine - ARRAY['context','date','weekDays','games','optimizer','startedTeams','teamMatchups','liveStats'],
    'oppLineup', theirs - ARRAY['context','date','weekDays','games','optimizer','startedTeams','teamMatchups','liveStats'],
    'forecast', public.get_matchup_forecast(matchup.id), 'announcements', announcements, 'todaysGames', mine->'games',
    'liveStats', (mine->'liveStats') || (theirs->'liveStats'), 'startedTeams', mine->'startedTeams', 'teamMatchups', mine->'teamMatchups');
END;
$$;

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

CREATE OR REPLACE FUNCTION public.view_league(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb; active uuid;
BEGIN
  CASE COALESCE(p_params->>'tab', 'results')
    WHEN 'results' THEN result := public.view_standings(p_league_id, p_member_id, p_params);
    WHEN 'history' THEN result := public.view_activity(p_league_id, p_member_id, p_params);
    WHEN 'picks' THEN result := public.view_picks(p_league_id, p_member_id, p_params);
    WHEN 'draftBoard' THEN result := public.view_picks(p_league_id, p_member_id, p_params);
    WHEN 'settings' THEN result := public.view_settings(p_league_id, p_member_id, p_params);
    WHEN 'draft' THEN result := public.view_draft_rooms(p_league_id, p_member_id, p_params);
    WHEN 'mockRooms' THEN result := public.view_draft_rooms(p_league_id, p_member_id, p_params);
    ELSE RAISE EXCEPTION 'Unknown league tab.' USING ERRCODE = '22023';
  END CASE;
  SELECT id INTO active FROM public.drafts WHERE league_id = p_league_id AND NOT is_mock
    AND league_season_id = (result->'context'->>'seasonId')::uuid
    AND (status IN ('pending', 'in_progress', 'paused') OR (draft_type = 'snake' AND status = 'completed'))
    ORDER BY CASE WHEN status IN ('in_progress', 'paused') THEN 0 WHEN status = 'pending' THEN 1 ELSE 2 END, created_at DESC LIMIT 1;
  RETURN result || jsonb_build_object('activeDraft', CASE WHEN active IS NOT NULL THEN
    public.view_draft_room(p_league_id, p_member_id, p_params || jsonb_build_object('draftId', active))->'draft' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.view_player(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; player public.players%ROWTYPE; average jsonb; fantasy numeric; lines jsonb; transactions jsonb; projection jsonb;
  games jsonb; fantasy_map jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id,
    p_params || jsonb_build_object('seasonYear', COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())));
  SELECT * INTO player FROM public.players WHERE id = (p_params->>'playerId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT averages, avg_fantasy_points INTO average, fantasy FROM public.player_season_averages
    WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  IF NOT FOUND THEN
    SELECT to_jsonb(row) INTO average FROM public.mv_player_season_averages row WHERE player_id = player.id AND season_year = (context->>'seasonYear')::integer;
    SELECT avg_fantasy_points INTO fantasy FROM public.v_player_avg_fantasy_points WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(stat) - 'game_id' || jsonb_build_object('nba_games', to_jsonb(game)) ORDER BY stat.game_date DESC, stat.id DESC), '[]')
    INTO lines FROM (SELECT stat.* FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id
      WHERE stat.player_id = player.id AND stat.season_year = (context->>'seasonYear')::integer AND game.nba_game_id LIKE '002%'
      ORDER BY stat.game_date DESC, stat.id DESC LIMIT 100) stat JOIN public.nba_games game ON game.id = stat.game_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'transactionType', t.transaction_type, 'label', CASE t.transaction_type
    WHEN 'fa_add' THEN 'Added' WHEN 'fa_drop' THEN 'Dropped' WHEN 'waiver_add' THEN 'Claimed' WHEN 'waiver_drop' THEN 'Dropped'
    WHEN 'trade_in' THEN 'Acquired via Trade' WHEN 'trade_out' THEN 'Traded Away' WHEN 'ir_designate' THEN 'Placed on IR'
    WHEN 'ir_return' THEN 'Activated from IR' WHEN 'taxi_designate' THEN 'Placed on Taxi Squad' WHEN 'taxi_return' THEN 'Activated from Taxi Squad'
    WHEN 'draft_won' THEN 'Drafted' WHEN 'carry_over' THEN 'Carried Over' ELSE t.transaction_type END,
    'teamName', COALESCE(member.team_name, 'Unknown'), 'occurredAt', t.occurred_at) ORDER BY t.occurred_at DESC, t.id DESC), '[]')
    INTO transactions FROM (SELECT * FROM public.roster_transactions WHERE league_id = p_league_id AND player_id = player.id
      ORDER BY occurred_at DESC, id DESC LIMIT 20) t LEFT JOIN public.league_members member ON member.id = t.member_id;
  SELECT to_jsonb(row) INTO projection FROM public.get_league_projection_rows(p_league_id, public.current_season_year_et(),
    (context->>'today')::date, 'today', ARRAY[player.id], 1, 0) row;
  WITH ordered AS (
    SELECT line, line->'nba_games' AS game, COALESCE((line->>'is_home')::boolean,
      CASE WHEN line->'nba_games'->>'home_team' = player.nba_team THEN true WHEN line->'nba_games'->>'away_team' = player.nba_team THEN false END) AS home
    FROM jsonb_array_elements(lines) line
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('gameId', line->'id', 'nbaGameId', game->'id', 'gameDate', game->'game_date',
    'opponent', CASE WHEN home THEN 'vs ' || (game->>'away_team') WHEN home = false THEN '@ ' || (game->>'home_team')
      ELSE (game->>'away_team') || ' @ ' || (game->>'home_team') END, 'isHome', COALESCE(home, false),
    'live', replace(lower(game->>'status'), '_', '') = 'inprogress', 'didNotPlay', line->'did_not_play',
    'minutes', line->'minutes_played', 'points', COALESCE(NULLIF(line->'points', 'null'), '0'), 'rebounds', COALESCE(NULLIF(line->'rebounds', 'null'), '0'),
    'assists', COALESCE(NULLIF(line->'assists', 'null'), '0'), 'steals', COALESCE(NULLIF(line->'steals', 'null'), '0'), 'blocks', COALESCE(NULLIF(line->'blocks', 'null'), '0'),
    'turnovers', COALESCE(NULLIF(line->'turnovers', 'null'), '0'), 'personalFouls', COALESCE(NULLIF(line->'personal_fouls', 'null'), '0'),
    'fgMade', COALESCE(NULLIF(line->'field_goals_made', 'null'), '0'), 'fgAttempted', COALESCE(NULLIF(line->'field_goals_attempted', 'null'), '0'),
    'threeMade', COALESCE(NULLIF(line->'three_pointers_made', 'null'), '0'), 'threeAttempted', COALESCE(NULLIF(line->'three_pointers_attempted', 'null'), '0'),
    'ftMade', COALESCE(NULLIF(line->'free_throws_made', 'null'), '0'), 'ftAttempted', COALESCE(NULLIF(line->'free_throws_attempted', 'null'), '0'),
    'plusMinus', COALESCE(NULLIF(line->'plus_minus', 'null'), '0'), 'doubleDouble', COALESCE(NULLIF(line->'double_double', 'null'), 'false'),
    'tripleDouble', COALESCE(NULLIF(line->'triple_double', 'null'), 'false')) ORDER BY game->>'game_date' DESC, line->>'id' DESC), '[]'),
    COALESCE(jsonb_object_agg(line->>'id', public.compute_fantasy_points((line->>'id')::uuid, p_league_id)), '{}')
    INTO games, fantasy_map FROM ordered;
  IF fantasy IS NULL THEN
    SELECT COALESCE(avg((fantasy_map->>(line->>'id'))::numeric) FILTER (WHERE NOT (line->>'did_not_play')::boolean), 0) INTO fantasy
      FROM jsonb_array_elements(lines) line;
  END IF;
  RETURN jsonb_build_object('context', context, 'player', to_jsonb(player) || jsonb_build_object('display_name', COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name))),
    'availableSeasons', COALESCE((SELECT jsonb_agg(season_year ORDER BY season_year DESC) FROM (
      SELECT season_year FROM public.mv_player_season_averages WHERE player_id = player.id
      UNION SELECT public.current_season_year_et()) years), '[]'),
    'averages', CASE WHEN COALESCE((average->>'games_played')::integer, 0) > 0 THEN jsonb_build_object(
      'gamesPlayed', average->'games_played', 'avgPoints', COALESCE(NULLIF(average->'avg_points', 'null'), '0'), 'avgRebounds', COALESCE(NULLIF(average->'avg_rebounds', 'null'), '0'),
      'avgAssists', COALESCE(NULLIF(average->'avg_assists', 'null'), '0'), 'avgSteals', COALESCE(NULLIF(average->'avg_steals', 'null'), '0'), 'avgBlocks', COALESCE(NULLIF(average->'avg_blocks', 'null'), '0'),
      'avgTurnovers', COALESCE(NULLIF(average->'avg_turnovers', 'null'), '0'), 'avgThreePointersMade', COALESCE(NULLIF(average->'avg_three_pointers_made', 'null'), '0'),
      'avgFieldGoalsMade', COALESCE(NULLIF(average->'avg_field_goals_made', 'null'), '0'), 'avgFieldGoalsAttempted', COALESCE(NULLIF(average->'avg_field_goals_attempted', 'null'), '0'),
      'avgFreeThrowsMade', COALESCE(NULLIF(average->'avg_free_throws_made', 'null'), '0'), 'avgFreeThrowsAttempted', COALESCE(NULLIF(average->'avg_free_throws_attempted', 'null'), '0'),
      'avgMinutesPlayed', COALESCE(NULLIF(average->'avg_minutes_played', 'null'), '0'), 'doubleDoubles', COALESCE(NULLIF(average->'double_doubles', 'null'), '0'), 'tripleDoubles', COALESCE(NULLIF(average->'triple_doubles', 'null'), '0')) END,
    'avgFantasyPoints', fantasy, 'lines', lines, 'transactions', transactions, 'projection', projection, 'nextProjection', projection,
    'gameLog', COALESCE((SELECT jsonb_agg(game ORDER BY ordinal) FROM jsonb_array_elements(games) WITH ORDINALITY entries(game, ordinal)
      WHERE ordinal <= LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100)), '[]'),
    'hasMoreGames', jsonb_array_length(games) > LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100),
    'includesLive', EXISTS (SELECT 1 FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean),
    'liveGame', (SELECT game FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean LIMIT 1),
    'fantasyPointsMap', fantasy_map, 'selectedSeason', (context->>'seasonYear')::integer,
    'ownership', (SELECT jsonb_build_object('memberId', r.member_id, 'teamName', COALESCE(m.team_name, 'Team'), 'isOnTaxi', r.is_on_taxi) FROM public.roster_players r JOIN public.league_members m ON m.id = r.member_id WHERE r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid AND r.player_id = player.id LIMIT 1),
    'clearsAt', (SELECT max(clears_at) FROM public.waiver_wire_log WHERE league_id = p_league_id AND player_id = player.id AND cleared_at IS NULL AND clears_at > now() AND league_season_id = (context->>'seasonId')::uuid),
    'scoringSettings', context->'league'->'scoring_settings', 'roster', public.view_roster(p_league_id, p_member_id, p_params));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_players(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
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
  SELECT COALESCE(jsonb_agg(to_jsonb(player)), '[]') INTO players FROM public.view_player_search(
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
  RETURN jsonb_build_object('context', context, 'players', players, 'ownedMap', ownership, 'waiverClearsAt', waivers,
    'waiverIds', COALESCE((SELECT jsonb_agg(key) FROM jsonb_each(waivers)), '[]'), 'pendingClaimIds', pending,
    'transactionState', transaction_state, 'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims',
    'hasMore', jsonb_array_length(players) = page_size, 'weekDays', public.view_lineup(p_league_id, p_member_id, p_params)->'weekDays',
    'visibleTotals', COALESCE((SELECT jsonb_agg(to_jsonb(totals)) FROM public.get_visible_player_totals(p_league_id,
      ARRAY(SELECT (player->>'id')::uuid FROM jsonb_array_elements(players) player),
      COALESCE((p_params->>'seasonYear')::integer, (players->0->>'stats_season_year')::integer, (context->>'seasonYear')::integer)) totals), '[]'));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_trade_details(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; trade public.trades%ROWTYPE; participants jsonb; items jsonb; estimate jsonb; unavailable text; result jsonb; analysis_context jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO trade FROM public.trades WHERE id = (p_params->>'tradeId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'trade', NULL, 'analysis', NULL); END IF;
  analysis_context := public.view_context(p_league_id, p_member_id, jsonb_build_object('seasonId', trade.league_season_id));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', participant.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'sortOrder', participant.sort_order, 'isInitiator', participant.is_initiator, 'acceptedAt', participant.accepted_at,
    'dropPlayerIds', participant.drop_player_ids, 'rosterMoves', participant.roster_moves)
    ORDER BY participant.sort_order, member.team_name, participant.member_id), '[]')
  INTO participants FROM public.trade_participants participant LEFT JOIN public.league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = trade.id;
  SELECT COALESCE(jsonb_agg(CASE WHEN item.player_id IS NOT NULL THEN jsonb_build_object('kind', 'player',
      'playerId', player.id, 'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position,
      'eligiblePositions', player.eligible_positions, 'nbaTeam', player.nba_team, 'nbaId', player.nba_id,
      'injuryStatus', player.injury_status, 'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number,
      'careerGames', player.career_regular_season_games, 'toTaxi', item.to_taxi, 'toIR', item.to_ir,
      'fromTaxi', EXISTS (SELECT 1 FROM public.roster_players r WHERE r.player_id = player.id AND r.member_id = item.from_member_id
        AND r.league_season_id = trade.league_season_id AND r.is_on_taxi),
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    WHEN item.pick_id IS NOT NULL THEN jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown'))
    ELSE jsonb_build_object('kind', 'faab', 'amount', item.faab_amount) END
    || jsonb_build_object('fromMemberId', item.from_member_id, 'toMemberId', item.to_member_id) ORDER BY item.id), '[]')
  INTO items FROM public.trade_items item LEFT JOIN public.players player ON player.id = item.player_id
    LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = public.current_season_year_et()
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = public.current_season_year_et()
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = public.current_season_year_et()
    WHERE item.trade_id = trade.id;
  SELECT CASE WHEN quote.id IS NOT NULL THEN jsonb_build_object('quoteId', quote.id, 'modelVersion', quote.model_version,
    'inputVersion', quote.input_version, 'createdAt', quote.created_at, 'teams', quote.analysis->'teams') END,
    recorded.unavailable_reason INTO estimate, unavailable FROM public.trade_estimates recorded
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id = recorded.quote_id WHERE recorded.trade_id = trade.id;
  result := jsonb_build_object('id', trade.id, 'status', trade.status, 'completionFailureReason', trade.completion_failure_reason,
    'proposedAt', trade.proposed_at, 'acceptedAt', trade.accepted_at, 'vetoWindowExpiresAt', trade.veto_window_expires_at,
    'completedAt', trade.completed_at, 'vetoedAt', trade.vetoed_at, 'expiresAt', trade.expires_at, 'notes', trade.notes,
    'proposerMemberId', trade.proposer_member_id, 'proposerTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.proposer_member_id), 'Unknown'),
    'recipientMemberId', trade.recipient_member_id, 'recipientTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.recipient_member_id), 'Unknown'),
    'isMultiTeam', trade.is_multi_team, 'participants', participants, 'parentTradeId', trade.parent_trade_id,
    'counteredFromTradeId', trade.countered_from_trade_id, 'editedFromTradeId', trade.edited_from_trade_id, 'replacedByTradeId', trade.replaced_by_trade_id,
    'version', trade.version, 'proposerFaabAmount', trade.proposer_faab_amount, 'recipientFaabAmount', trade.recipient_faab_amount,
    'myVetoed', EXISTS (SELECT 1 FROM public.trade_vetos WHERE trade_id = trade.id AND member_id = p_member_id),
    'routedItems', items, 'estimate', estimate, 'estimateUnavailable', unavailable);
  RETURN jsonb_build_object('context', context, 'trade', result,
    'roster', public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId')->'roster',
    'savedQuote', (SELECT jsonb_build_object('id', q.id, 'analysis', q.analysis, 'modelVersion', q.model_version, 'inputVersion', q.input_version, 'createdAt', q.created_at, 'expiresAt', q.expires_at, 'seasonYear', q.inputs->'seasonYear') FROM public.trade_estimates e JOIN public.trade_estimate_quotes q ON q.id = e.quote_id WHERE e.trade_id = trade.id),
    'rosterPreview', CASE WHEN COALESCE((p_params->>'includeRosterPreview')::boolean, true)
      THEN public.view_trade_preview(p_league_id, p_member_id, p_params) END,
    'analysis', (SELECT revaluation FROM public.trade_value_cache WHERE trade_id = trade.id),
    'analysisStale', COALESCE((SELECT valid_until <= now() OR version <> (analysis_context->>'version')::bigint
      OR (analysis_context->>'stale')::boolean FROM public.trade_value_cache WHERE trade_id = trade.id), true));
END;
$$;
