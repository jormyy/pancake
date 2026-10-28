CREATE OR REPLACE FUNCTION public.view_home(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; matchup public.matchups%ROWTYPE; opponent uuid; selected date;
  mine jsonb; theirs jsonb; records jsonb; matchup_data jsonb; league_matchups jsonb; announcements jsonb; league_today date; league_week integer;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  league_today := (now() AT TIME ZONE COALESCE(context->'league'->>'timezone', 'America/Los_Angeles'))::date;
  SELECT week_number INTO league_week FROM public.season_weeks WHERE season_year = (context->>'seasonYear')::integer
    ORDER BY CASE WHEN league_today BETWEEN week_start AND week_end THEN 0 WHEN week_start > league_today THEN 1 ELSE 2 END,
      CASE WHEN week_start >= league_today THEN week_start END, week_end DESC LIMIT 1;
  context := context || jsonb_build_object('today', league_today, 'weekNumber', COALESCE((p_params->>'weekNumber')::integer, league_week));
  p_params := p_params || jsonb_build_object('weekNumber', context->'weekNumber');
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

CREATE OR REPLACE FUNCTION public.view_lineup(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id);
  selected date; today date; starters jsonb; bench jsonb; ir jsonb; taxi jsonb; days jsonb; game_day jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  context := context || jsonb_build_object('weekNumber', COALESCE((context->>'weekNumber')::integer, 1));
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This lineup is not available.' USING ERRCODE = '42501'; END IF;
  today := (context->>'today')::date;
  selected := COALESCE((p_params->>'date')::date, today);
  WITH assignments AS MATERIALIZED (
    SELECT player_id, slot_type FROM public.weekly_lineups WHERE member_id = target AND league_id = p_league_id
      AND league_season_id = (context->>'seasonId')::uuid AND game_date = selected
  ), roster AS MATERIALIZED (
    SELECT * FROM public.roster_players WHERE member_id = target AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
  ), players AS MATERIALIZED (
    SELECT p.id, r.is_on_ir, r.is_on_taxi, r.id AS roster_id, jsonb_build_object('rosterPlayerId', COALESCE(r.id::text, ''),
      'playerId', p.id, 'displayName', COALESCE(p.display_name, ''), 'position', p.position,
      'eligiblePositions', CASE WHEN cardinality(p.eligible_positions) > 0 THEN to_jsonb(p.eligible_positions)
        WHEN p.position IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.position) END,
      'nbaTeam', p.nba_team, 'yearsExp', p.years_exp, 'careerGames', p.career_regular_season_games,
      'injuryStatus', p.injury_status, 'nbaId', p.nba_id) AS data
    FROM public.players p LEFT JOIN roster r ON r.player_id = p.id
    WHERE r.id IS NOT NULL OR EXISTS (SELECT 1 FROM assignments a WHERE a.player_id = p.id)
  ), placed AS MATERIALIZED (
    SELECT a.*, row_number() OVER (PARTITION BY a.slot_type ORDER BY a.player_id) AS slot_number
    FROM assignments a LEFT JOIN roster r ON r.player_id = a.player_id
    WHERE a.slot_type NOT IN ('BE', 'IR') AND (selected <= today OR NOT COALESCE(r.is_on_ir OR r.is_on_taxi, false))
  ), occupied AS MATERIALIZED (
    SELECT t.slot_type, sequence.number, player.data, player.id FROM public.lineup_slot_templates t
      CROSS JOIN LATERAL generate_series(1, t.slot_count) sequence(number)
      LEFT JOIN placed a ON a.slot_type = t.slot_type AND a.slot_number = sequence.number
      LEFT JOIN players player ON player.id = a.player_id
    WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('slotType', slot_type, 'player', data) ORDER BY slot_type, number) FROM occupied), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.roster_id IS NOT NULL AND NOT p.is_on_ir AND NOT p.is_on_taxi
      AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)
      AND NOT (selected < today AND EXISTS (SELECT 1 FROM public.roster_transactions transaction
        WHERE transaction.member_id = target AND transaction.league_id = p_league_id AND transaction.league_season_id = (context->>'seasonId')::uuid
          AND transaction.player_id = p.id AND transaction.transaction_type IN ('fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over')
          AND transaction.occurred_at > ((selected + 1)::timestamp AT TIME ZONE 'America/New_York') - interval '1 millisecond'))), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.is_on_ir AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.is_on_taxi AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)), '[]')
  INTO starters, bench, ir, taxi FROM players p;
  WITH dates AS (
    SELECT generate_series(CASE WHEN week.week_number = 1 THEN date_trunc('week', week.week_start::timestamp)::date ELSE week.week_start END,
      week.week_end, interval '1 day')::date AS day FROM public.season_weeks week
      WHERE week.season_year = (context->>'seasonYear')::integer AND week.week_number = (context->>'weekNumber')::integer
    UNION
    SELECT DISTINCT game.game_date FROM public.nba_games game
      WHERE game.season_year = (context->>'seasonYear')::integer AND game.week_number = (context->>'weekNumber')::integer
        AND NOT EXISTS (SELECT 1 FROM public.season_weeks week WHERE week.season_year = (context->>'seasonYear')::integer
          AND week.week_number = (context->>'weekNumber')::integer)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', day, 'dayLabel', substring('SMTWTFS', extract(dow FROM day)::integer + 1, 1),
    'dateNum', extract(day FROM day), 'isToday', day = (now() AT TIME ZONE COALESCE(context->'league'->>'timezone', 'America/Los_Angeles'))::date,
    'hasGames', EXISTS (SELECT 1 FROM public.nba_games g WHERE g.season_year = (context->>'seasonYear')::integer AND g.game_date = day),
    'playingTeams', COALESCE((SELECT jsonb_agg(team ORDER BY game_id, side) FROM (
      SELECT g.id AS game_id, 0 AS side, g.home_team AS team FROM public.nba_games g WHERE g.game_date = day AND g.season_year = (context->>'seasonYear')::integer
      UNION ALL SELECT g.id, 1, g.away_team FROM public.nba_games g WHERE g.game_date = day AND g.season_year = (context->>'seasonYear')::integer
    ) teams), '[]')) ORDER BY day), '[]') INTO days FROM dates;
  game_day := public.view_game_day(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected, 'playerIds',
    COALESCE((SELECT jsonb_agg(DISTINCT id) FROM (
      SELECT item->'player'->>'playerId' AS id FROM jsonb_array_elements(starters) item
      UNION SELECT item->>'playerId' FROM jsonb_array_elements(bench || ir || taxi) item) ids WHERE id IS NOT NULL), '[]')));
  RETURN jsonb_build_object('context', context, 'date', selected, 'starters', starters, 'bench', bench, 'ir', ir, 'taxi', taxi,
    'benchSlots', COALESCE((SELECT slot_count FROM public.lineup_slot_templates WHERE league_id = p_league_id AND slot_type = 'BE'), 0),
    'weekDays', days, 'games', game_day->'games', 'startedTeams', game_day->'startedTeams', 'teamMatchups', game_day->'teamMatchups', 'liveStats', game_day->'liveStats',
    'optimizer', (SELECT to_jsonb(settings) FROM public.lineup_optimizer_settings settings
      WHERE settings.member_id = p_member_id AND settings.league_season_id = (context->>'seasonId')::uuid));
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
