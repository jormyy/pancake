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
    'version', version, 'stale', COALESCE(dirty, true));
END;
$$;

REVOKE ALL ON FUNCTION public.view_context(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_context(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_transaction_state(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.view_context(p_league_id, p_member_id, p_params);
  SELECT jsonb_build_object('leagueSeasonId', state.league_season_id, 'weekNumber', state.week_number,
    'weeklyAddLimit', state.weekly_add_limit, 'weeklyAddCount', state.weekly_add_count, 'waiverMode', state.waiver_mode,
    'faabStartingBudget', state.faab_starting_budget, 'faabBalance', state.faab_balance, 'addLimitResetsAt', state.add_limit_resets_at,
    'addLimitMessage', state.add_limit_message, 'addLimitResetsLabel', state.add_limit_resets_label) INTO result
    FROM public.get_member_transaction_state(p_member_id, p_league_id) state;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.view_transaction_state(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_transaction_state(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_standings(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; rows jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', member.id, 'teamName', COALESCE(member.team_name, 'Team'),
    'wins', COALESCE(c.wins, 0), 'losses', COALESCE(c.losses, 0), 'ties', COALESCE(c.ties, 0),
    'pointsFor', COALESCE(c.points_for, 0), 'pointsAgainst', COALESCE(c.points_against, 0), 'maxPointsFor', COALESCE(c.max_points_for, 0))
    ORDER BY (COALESCE(c.wins, 0) + 0.5 * COALESCE(c.ties, 0)) / GREATEST(COALESCE(c.wins + c.losses + c.ties, 0), 1) DESC,
      COALESCE(c.points_for, 0) / GREATEST(COALESCE(c.wins + c.losses + c.ties, 0), 1) DESC,
      COALESCE(c.max_points_for, 0) DESC, COALESCE(c.points_against, 0), COALESCE(member.team_name, 'Team') COLLATE "en-US-x-icu", member.id), '[]')
  INTO rows FROM public.league_members member LEFT JOIN public.standings_current c ON c.member_id = member.id
    AND c.league_season_id = (context->>'seasonId')::uuid AND (context->'season'->>'is_current')::boolean
  WHERE member.league_id = p_league_id;
  RETURN jsonb_build_object('context', context, 'standings', rows);
END;
$$;

REVOKE ALL ON FUNCTION public.view_standings(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_standings(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_picks(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; picks jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pick.id, 'seasonYear', pick.season_year, 'round', pick.round,
    'isUsed', pick.is_used, 'originalOwnerMemberId', pick.original_owner_id, 'originalTeamName', COALESCE(original.team_name, 'Unknown'),
    'currentOwnerMemberId', pick.current_owner_id, 'currentTeamName', COALESCE(owner.team_name, 'Unknown')) ORDER BY pick.season_year, pick.round, pick.id), '[]')
  INTO picks FROM public.draft_picks pick LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.league_members owner ON owner.id = pick.current_owner_id
  WHERE pick.league_id = p_league_id AND NOT pick.is_used
    AND (p_params->>'targetMemberId' IS NULL OR pick.current_owner_id = (p_params->>'targetMemberId')::uuid);
  RETURN jsonb_build_object('context', context, 'picks', picks);
END;
$$;

REVOKE ALL ON FUNCTION public.view_picks(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_picks(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_claims(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
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
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', claim.id, 'playerId', claim.player_id,
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

REVOKE ALL ON FUNCTION public.view_claims(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_claims(uuid,uuid,jsonb) TO authenticated;

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
      ORDER BY r.is_on_taxi, r.is_on_ir, r.player_id), '[]'),
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

REVOKE ALL ON FUNCTION public.view_roster(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_roster(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_game_day(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; selected date; games jsonb; started_teams jsonb; opponents jsonb; stats jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  selected := COALESCE((p_params->>'date')::date, (context->>'today')::date);
  WITH slate AS MATERIALIZED (SELECT * FROM public.nba_games WHERE game_date = selected), teams AS (
    SELECT id, home_team AS team, away_team AS opponent, true AS home, status IN ('InProgress','Final') OR game_time <= now() OR started_at <= now() AS started FROM slate
    UNION ALL SELECT id, away_team, home_team, false, status IN ('InProgress','Final') OR game_time <= now() OR started_at <= now() FROM slate
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'nba_game_id', nba_game_id, 'home_team', home_team,
      'away_team', away_team, 'home_score', home_score, 'away_score', away_score, 'status', status,
      'game_status_text', game_status_text, 'game_date', game_date) ORDER BY game_time, id) FROM slate WHERE nba_game_id LIKE '002%'), '[]'),
    COALESCE(jsonb_agg(DISTINCT team) FILTER (WHERE started AND team IS NOT NULL), '[]'),
    COALESCE(jsonb_object_agg(team, jsonb_build_object('opponent', opponent, 'isHome', home) ORDER BY id) FILTER (WHERE team IS NOT NULL AND opponent IS NOT NULL), '{}')
  INTO games, started_teams, opponents FROM teams;
  SELECT COALESCE(jsonb_object_agg(stat.player_id::text, jsonb_build_object('points', COALESCE(stat.points, 0),
    'rebounds', COALESCE(stat.rebounds, 0), 'assists', COALESCE(stat.assists, 0), 'steals', COALESCE(stat.steals, 0),
    'blocks', COALESCE(stat.blocks, 0), 'turnovers', stat.turnovers, 'threeMade', COALESCE(stat.three_pointers_made, 0),
    'fgMade', COALESCE(stat.field_goals_made, 0), 'fgAttempted', COALESCE(stat.field_goals_attempted, 0),
    'ftMade', COALESCE(stat.free_throws_made, 0), 'ftAttempted', COALESCE(stat.free_throws_attempted, 0),
    'fouls', COALESCE(stat.personal_fouls, 0), 'doubleDouble', COALESCE(stat.double_double, false),
    'tripleDouble', COALESCE(stat.triple_double, false), 'minutesPlayed', stat.minutes_played, 'didNotPlay', COALESCE(stat.did_not_play, false)) ORDER BY stat.id), '{}')
  INTO stats FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id AND game.nba_game_id LIKE '002%'
  WHERE stat.game_date = selected AND stat.player_id IN (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_params->'playerIds', '[]')));
  RETURN jsonb_build_object('games', games, 'startedTeams', started_teams, 'teamMatchups', opponents, 'liveStats', stats);
END;
$$;

REVOKE ALL ON FUNCTION public.view_game_day(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_game_day(uuid,uuid,jsonb) TO authenticated;

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
    'dateNum', extract(day FROM day), 'isToday', day = today,
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

REVOKE ALL ON FUNCTION public.view_lineup(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_lineup(uuid,uuid,jsonb) TO authenticated;

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
    'myPoints', CASE WHEN matchup.home_member_id = p_member_id THEN totals.home_points ELSE totals.away_points END,
    'opponentPoints', CASE WHEN matchup.home_member_id = p_member_id THEN totals.away_points ELSE totals.home_points END,
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
    'homePoints', totals.home_points, 'awayPoints', totals.away_points, 'isFinalized', m.is_finalized,
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

REVOKE ALL ON FUNCTION public.view_home(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_home(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_player_search(
  p_query text DEFAULT '',
  p_position text DEFAULT 'ALL',
  p_teams text[] DEFAULT '{}',
  p_league_id uuid DEFAULT NULL,
  p_playing_teams text[] DEFAULT NULL,
  p_excluded_teams text[] DEFAULT '{}',
  p_include_player_ids uuid[] DEFAULT NULL,
  p_exclude_player_ids uuid[] DEFAULT '{}',
  p_rookies_only boolean DEFAULT false,
  p_health text DEFAULT 'all',
  p_sort_by text DEFAULT 'fpts',
  p_sort_dir text DEFAULT 'desc',
  p_season_year int DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  status text,
  injury_status text,
  headshot_url text,
  nba_id text,
  years_exp int,
  avg_fantasy_points numeric,
  avg_points numeric,
  avg_rebounds numeric,
  avg_assists numeric,
  avg_steals numeric,
  avg_blocks numeric,
  avg_turnovers numeric,
  avg_three_pointers_made numeric,
  avg_minutes_played numeric,
  games_played int,
  projection_fantasy_points numeric,
  projection_source text,
  projection_source_label text,
  projection_view text,
  projection_fetched_at timestamptz,
  projection_date date,
  projection_opponent text,
  projection_minutes numeric,
  projection_points numeric,
  projection_rebounds numeric,
  projection_assists numeric,
  projection_steals numeric,
  projection_blocks numeric,
  projection_three_pointers_made numeric,
  projection_turnovers numeric,
  projection_status text,
  stats_season_year int,
  career_regular_season_games int
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  v_stats_season int;
  v_current_season int := public.current_season_year_et();
BEGIN
v_stats_season := COALESCE(p_season_year, CASE WHEN EXISTS (
  SELECT 1
  FROM public.nba_games g
  WHERE g.season_year = v_current_season
    AND public.is_regular_season_game_id(g.nba_game_id)
    AND (g.status = 'Final' OR EXISTS (
      SELECT 1 FROM public.player_game_stats s
      WHERE s.game_id = g.id
        AND NOT s.did_not_play
        AND (s.minutes_played > 0 OR s.points > 0 OR s.rebounds > 0
          OR s.assists > 0 OR s.steals > 0 OR s.blocks > 0
          OR s.turnovers > 0 OR s.field_goals_attempted > 0
          OR s.free_throws_attempted > 0)
    ))
) THEN v_current_season ELSE v_current_season - 1 END);
RETURN QUERY
WITH args AS (
  SELECT
    NULLIF(trim(COALESCE(p_query, '')), '') AS query_text,
    CASE COALESCE(p_position, 'ALL')
      WHEN 'ALL' THEN ARRAY[]::text[]
      WHEN 'G' THEN ARRAY['PG', 'SG']::text[]
      WHEN 'F' THEN ARRAY['SF', 'PF']::text[]
      ELSE ARRAY[p_position]::text[]
    END AS pos_filter,
    CASE
      WHEN p_playing_teams IS NOT NULL AND cardinality(COALESCE(p_teams, '{}')) > 0 THEN
          ARRAY(
            SELECT explicit_team
            FROM unnest(COALESCE(p_teams, '{}')) AS explicit_team
            WHERE explicit_team = ANY(COALESCE(p_playing_teams, '{}'))
            ORDER BY explicit_team
          )
      WHEN p_playing_teams IS NOT NULL THEN COALESCE(p_playing_teams, '{}')
      ELSE COALESCE(p_teams, '{}')
    END AS effective_teams,
    (p_playing_teams IS NOT NULL OR cardinality(COALESCE(p_teams, '{}')) > 0) AS team_filter_active,
    COALESCE(p_excluded_teams, '{}') AS excluded_teams,
    COALESCE(p_exclude_player_ids, '{}') AS exclude_player_ids,
    LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) AS page_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS page_offset
),
current_averages AS MATERIALIZED (
  SELECT cached.player_id, cached.season_year, cached.avg_fantasy_points,
    (cached.averages->>'avg_points')::numeric AS avg_points,
    (cached.averages->>'avg_rebounds')::numeric AS avg_rebounds,
    (cached.averages->>'avg_assists')::numeric AS avg_assists,
    (cached.averages->>'avg_steals')::numeric AS avg_steals,
    (cached.averages->>'avg_blocks')::numeric AS avg_blocks,
    (cached.averages->>'avg_turnovers')::numeric AS avg_turnovers,
    (cached.averages->>'avg_three_pointers_made')::numeric AS avg_three_pointers_made,
    (cached.averages->>'avg_minutes_played')::numeric AS avg_minutes_played,
    (cached.averages->>'games_played')::integer AS games_played
  FROM public.player_season_averages cached
  WHERE cached.league_id = p_league_id AND cached.season_year = v_stats_season
    AND v_stats_season = v_current_season AND cached.averages IS NOT NULL
    AND (p_include_player_ids IS NULL OR cached.player_id = ANY(p_include_player_ids))
),
season_averages AS (
  SELECT
    player_id,
    season_year,
    avg_points,
    avg_rebounds,
    avg_assists,
    avg_steals,
    avg_blocks,
    avg_turnovers,
    avg_three_pointers_made,
    avg_minutes_played,
    games_played
  FROM current_averages
  UNION ALL
  SELECT
    player_id,
    season_year,
    avg_points,
    avg_rebounds,
    avg_assists,
    avg_steals,
    avg_blocks,
    avg_turnovers,
    avg_three_pointers_made,
    avg_minutes_played,
    games_played
  FROM public.mv_player_season_averages
  WHERE season_year = v_stats_season AND v_stats_season <> v_current_season
),
league_scores AS MATERIALIZED (
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM public.v_player_avg_fantasy_points AS fp
  WHERE fp.league_id = p_league_id
    AND fp.season_year = v_stats_season
    AND v_stats_season <> v_current_season
    AND (p_include_player_ids IS NULL OR fp.player_id = ANY(p_include_player_ids))
),
score_source AS (
  SELECT player_id, avg_fantasy_points FROM current_averages
  UNION ALL
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM public.v_player_avg_fantasy_points AS fp
  WHERE fp.league_id = p_league_id
    AND fp.season_year = v_stats_season
    AND v_stats_season <> v_current_season
    AND NOT COALESCE(p_health IN ('healthy', 'gtd', 'out', 'ir'), false)
  UNION ALL
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM league_scores AS fp
  WHERE p_health IN ('healthy', 'gtd', 'out', 'ir')
),
filtered_base AS (
  SELECT
    p.id,
    COALESCE(p.display_name, concat_ws(' ', p.first_name, p.last_name)) AS display_name,
    p.nba_team,
    p.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(p.eligible_positions) AS pos) AS eligible_positions,
    p.status,
    p.injury_status,
    p.headshot_url,
    p.nba_id,
    p.years_exp,
    p.career_regular_season_games,
    fp.avg_fantasy_points,
    avg.avg_points,
    avg.avg_rebounds,
    avg.avg_assists,
    avg.avg_steals,
    avg.avg_blocks,
    avg.avg_turnovers,
    avg.avg_three_pointers_made,
    avg.avg_minutes_played,
    avg.games_played::int AS games_played
  FROM args
  JOIN public.players AS p ON true
  LEFT JOIN season_averages AS avg
    ON avg.player_id = p.id
   AND avg.season_year = v_stats_season
  LEFT JOIN score_source AS fp
    ON fp.player_id = p.id
  WHERE
    (args.query_text IS NULL OR p.display_name ILIKE ('%' || args.query_text || '%'))
    AND (cardinality(args.pos_filter) = 0 OR EXISTS (
      SELECT 1
      FROM unnest(p.eligible_positions) AS player_position
      WHERE player_position::text = ANY(args.pos_filter)
    ))
    AND (NOT args.team_filter_active OR (cardinality(args.effective_teams) > 0 AND p.nba_team = ANY(args.effective_teams)))
    AND (cardinality(args.excluded_teams) = 0 OR p.nba_team IS NULL OR p.nba_team <> ALL(args.excluded_teams))
    AND (p_include_player_ids IS NULL OR p.id = ANY(p_include_player_ids))
    AND (cardinality(args.exclude_player_ids) = 0 OR p.id <> ALL(args.exclude_player_ids))
    AND (NOT p_rookies_only OR p.years_exp = 0)
    AND CASE COALESCE(p_health, 'all')
      WHEN 'healthy' THEN p.injury_status IS NULL
      WHEN 'gtd' THEN p.injury_status = ANY(ARRAY['GTD', 'DTD', 'Questionable', 'Game Time Decision'])
      WHEN 'out' THEN p.injury_status = ANY(ARRAY['Out', 'OUT', 'O'])
      WHEN 'ir' THEN p.injury_status = ANY(ARRAY['IR', 'IR-LTI'])
      ELSE true
    END
),
paged_base AS (
  SELECT *
  FROM (
    SELECT
      filtered_base.*,
      row_number() OVER (
        ORDER BY
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir = 'asc' THEN filtered_base.avg_fantasy_points END ASC NULLS LAST,
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir <> 'asc' THEN filtered_base.avg_fantasy_points END DESC NULLS LAST,
          CASE WHEN p_sort_by = 'min' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_minutes_played, 0) END ASC,
          CASE WHEN p_sort_by = 'min' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_minutes_played, 0) END DESC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_points, 0) END ASC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_points, 0) END DESC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END ASC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END DESC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END ASC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END DESC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END ASC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END DESC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END ASC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END DESC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END ASC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END DESC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END ASC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END DESC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.games_played, 0) END ASC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.games_played, 0) END DESC,
          filtered_base.display_name ASC,
          filtered_base.id ASC
      ) AS page_rank
    FROM filtered_base
  ) ranked_base
  ORDER BY page_rank
  LIMIT (SELECT page_limit FROM args)
  OFFSET (SELECT page_offset FROM args)
),
projection AS (
  SELECT *
  FROM public.get_league_projection_rows(
    p_league_id,
    v_stats_season,
    (timezone('America/New_York', now()))::date,
    'today',
    COALESCE((SELECT array_agg(paged_base.id ORDER BY paged_base.id) FROM paged_base), ARRAY[]::uuid[]),
    (SELECT page_limit FROM args),
    0
  )
  WHERE p_league_id IS NOT NULL
)
SELECT
  pb.id,
  pb.display_name,
  pb.nba_team,
  pb."position",
  pb.eligible_positions,
  pb.status,
  pb.injury_status,
  pb.headshot_url,
  pb.nba_id,
  pb.years_exp,
  pb.avg_fantasy_points,
  pb.avg_points,
  pb.avg_rebounds,
  pb.avg_assists,
  pb.avg_steals,
  pb.avg_blocks,
  pb.avg_turnovers,
  pb.avg_three_pointers_made,
  pb.avg_minutes_played,
  pb.games_played,
  proj.projection_fantasy_points,
  proj.projection_source,
  proj.projection_source_label,
  proj.projection_view,
  proj.projection_fetched_at,
  proj.projection_date,
  proj.next_game_opponent AS projection_opponent,
  proj.projection_minutes,
  proj.projection_points,
  proj.projection_rebounds,
  proj.projection_assists,
  proj.projection_steals,
  proj.projection_blocks,
  proj.projection_three_pointers_made,
  proj.projection_turnovers,
  proj.projection_status,
  v_stats_season,
  pb.career_regular_season_games
FROM paged_base pb
LEFT JOIN projection AS proj
  ON proj.player_id = pb.id
ORDER BY pb.page_rank;
END;
$$;

REVOKE ALL ON FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer) TO authenticated;

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
  IF p_params->>'availability' = 'mine' THEN SELECT COALESCE(array_agg(key::uuid), '{}') INTO include_ids FROM jsonb_each(ownership) WHERE value->>'memberId' = p_member_id::text;
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
    p_playing_teams := CASE WHEN p_params ? 'playingTeams' THEN ARRAY(SELECT jsonb_array_elements_text(p_params->'playingTeams')) END,
    p_excluded_teams := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_params->'excludedTeams', '[]'))),
    p_include_player_ids := include_ids, p_exclude_player_ids := exclude_ids,
    p_rookies_only := COALESCE((p_params->>'rookiesOnly')::boolean, false), p_health := COALESCE(p_params->>'health', 'all'),
    p_sort_by := COALESCE(p_params->>'sortBy', 'fpts'), p_sort_dir := COALESCE(p_params->>'sortDir', 'desc'),
    p_season_year := (p_params->>'seasonYear')::integer, p_limit := page_size,
    p_offset := GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0)) player;
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('context', context, 'players', players, 'ownedMap', ownership, 'waiverClearsAt', waivers,
    'waiverIds', COALESCE((SELECT jsonb_agg(key) FROM jsonb_each(waivers)), '[]'), 'pendingClaimIds', pending,
    'transactionState', transaction_state, 'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims',
    'hasMore', jsonb_array_length(players) = page_size,
    'visibleTotals', COALESCE((SELECT jsonb_agg(to_jsonb(totals)) FROM public.get_visible_player_totals(p_league_id,
      ARRAY(SELECT (player->>'id')::uuid FROM jsonb_array_elements(players) player),
      COALESCE((p_params->>'seasonYear')::integer, (players->0->>'stats_season_year')::integer, (context->>'seasonYear')::integer)) totals), '[]'));
END;
$$;

REVOKE ALL ON FUNCTION public.view_players(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_players(uuid,uuid,jsonb) TO authenticated;

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
    'scoringSettings', context->'league'->'scoring_settings', 'roster', public.view_roster(p_league_id, p_member_id, p_params));
END;
$$;

REVOKE ALL ON FUNCTION public.view_player(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_player(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_claim_editor(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; roster jsonb; support jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  IF p_params->>'playerId' IS NULL THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
  roster := public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId');
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

REVOKE ALL ON FUNCTION public.view_claim_editor(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_claim_editor(uuid,uuid,jsonb) TO authenticated;

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
    'isSystem', feed.is_system, 'title', feed.title, 'body', feed.body, 'participantTeamNames', feed.participant_team_names)), '[]')
  INTO rows FROM public.get_league_activity_feed(p_league_id, page_size, GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0)) feed
    LEFT JOIN public.players player ON player.id = feed.player_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(announcement) ORDER BY announcement.published_at DESC), '[]') INTO announcements
    FROM public.notif_list_announcements(p_league_id) announcement;
  RETURN jsonb_build_object('context', context, 'rows', rows, 'announcements', announcements,
    'hasMore', jsonb_array_length(rows) = page_size, 'offset', GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0) + jsonb_array_length(rows));
END;
$$;

REVOKE ALL ON FUNCTION public.view_activity(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_activity(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_settings(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; priority jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', member.id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'displayName', COALESCE(profile.display_name, profile.username, '—'), 'priority', priority.priority) ORDER BY priority.priority), '[]')
  INTO priority FROM public.waiver_priorities priority JOIN public.league_members member ON member.id = priority.member_id
    LEFT JOIN public.profiles profile ON profile.id = member.user_id
  WHERE priority.league_id = p_league_id AND priority.league_season_id = (context->>'seasonId')::uuid AND (context->'season'->>'is_current')::boolean;
  RETURN jsonb_build_object('context', context, 'league', context->'league', 'waiverOrder', priority,
    'slotTemplates', COALESCE((SELECT jsonb_agg(to_jsonb(template)) FROM public.lineup_slot_templates template WHERE league_id = p_league_id), '[]'));
END;
$$;

REVOKE ALL ON FUNCTION public.view_settings(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_settings(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_profile(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; profile jsonb; preferences jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501'; END IF;
  IF p_league_id IS NOT NULL THEN context := public.view_context(p_league_id, p_member_id, p_params); END IF;
  SELECT jsonb_build_object('id', id, 'username', username, 'display_name', display_name,
    'avatar_url', avatar_url, 'created_at', created_at, 'updated_at', updated_at)
    INTO profile FROM public.profiles WHERE id = auth.uid();
  SELECT jsonb_build_object('tradeEnabled', trade_enabled, 'waiverEnabled', waiver_enabled,
    'draftEnabled', draft_enabled, 'activityEnabled', activity_enabled, 'masterEnabled', master_enabled,
    'categories', category_settings, 'events', event_settings) INTO preferences FROM public.notification_preferences WHERE user_id = auth.uid();
  RETURN jsonb_build_object('context', context, 'profile', profile, 'preferences', COALESCE(preferences,
    '{"tradeEnabled":true,"waiverEnabled":true,"draftEnabled":true,"activityEnabled":true,"masterEnabled":true,"categories":{},"events":{}}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.view_profile(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_profile(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_trade_preview(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.view_context(p_league_id, p_member_id, p_params);
  IF NOT EXISTS (SELECT 1 FROM public.trades WHERE id = (p_params->>'tradeId')::uuid AND league_id = p_league_id
    AND private.can_read_trade(id)) THEN RAISE EXCEPTION 'This trade is not available.' USING ERRCODE = '42501'; END IF;
  RETURN public.get_trade_roster_preview((p_params->>'tradeId')::uuid, auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.view_trade_preview(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_trade_preview(uuid,uuid,jsonb) TO authenticated;

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
    'rosterPreview', CASE WHEN COALESCE((p_params->>'includeRosterPreview')::boolean, true)
      THEN public.view_trade_preview(p_league_id, p_member_id, p_params) END,
    'analysis', (SELECT revaluation FROM public.trade_value_cache WHERE trade_id = trade.id),
    'analysisStale', COALESCE((SELECT valid_until <= now() OR version <> (analysis_context->>'version')::bigint
      OR (analysis_context->>'stale')::boolean FROM public.trade_value_cache WHERE trade_id = trade.id), true));
END;
$$;

REVOKE ALL ON FUNCTION public.view_trade_details(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_trade_details(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_trade_block(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; items jsonb; roster jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', item.id, 'memberId', item.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'note', item.note, 'updatedAt', item.updated_at, 'rosterLocation', CASE WHEN roster.id IS NOT NULL THEN
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END END,
    'asset', CASE WHEN player.id IS NOT NULL THEN jsonb_build_object('kind', 'player', 'playerId', player.id,
      'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position, 'eligiblePositions', player.eligible_positions,
      'nbaTeam', player.nba_team, 'nbaId', player.nba_id, 'injuryStatus', player.injury_status,
      'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number, 'careerGames', player.career_regular_season_games,
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    ELSE jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown')) END) ORDER BY item.updated_at DESC, item.id), '[]')
  INTO items FROM public.trade_block_items item JOIN public.league_members member ON member.id = item.member_id
    LEFT JOIN public.players player ON player.id = item.player_id LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id
    LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.roster_players roster ON roster.player_id = item.player_id AND roster.member_id = item.member_id
      AND roster.league_season_id = (context->>'seasonId')::uuid
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = public.current_season_year_et()
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = public.current_season_year_et()
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = public.current_season_year_et()
  WHERE item.league_id = p_league_id AND (context->'season'->>'is_current')::boolean AND (player.id IS NOT NULL OR pick.id IS NOT NULL);
  roster := public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId');
  RETURN jsonb_build_object('context', context, 'block', items, 'items', items, 'roster', roster->'roster', 'picks', roster->'picks',
    'avgMap', roster->'avgMap', 'avgStatsMap', roster->'avgStatsMap');
END;
$$;

REVOKE ALL ON FUNCTION public.view_trade_block(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_trade_block(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_trades(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; refs jsonb; rows jsonb; page_size integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 40), 1), 99);
  has_more boolean; next_cursor jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  IF COALESCE(p_params->>'tab', 'offers') = 'history' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(ref)), '[]') INTO refs FROM (
      SELECT trade.id AS trade_id, jsonb_build_object('proposedAt', trade.proposed_at, 'tradeId', trade.id)::text AS cursor_token
      FROM public.trade_participants participant JOIN public.trades trade ON trade.id = participant.trade_id
      WHERE participant.league_id = p_league_id AND participant.member_id = p_member_id AND trade.status <> 'pending'
        AND (p_params->>'cursor' IS NULL OR (trade.proposed_at, trade.id) < (
          ((p_params->>'cursor')::jsonb->>'proposedAt')::timestamptz, ((p_params->>'cursor')::jsonb->>'tradeId')::uuid))
      ORDER BY participant.proposed_at DESC, participant.trade_id DESC LIMIT page_size + 1) ref;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(ref)), '[]') INTO refs FROM public.get_trade_page_refs(p_member_id, p_league_id, page_size + 1, p_params->>'cursor') ref;
  END IF;
  has_more := jsonb_array_length(refs) > page_size;
  SELECT COALESCE(jsonb_agg(public.view_trade_details(p_league_id, p_member_id,
    jsonb_build_object('tradeId', ref->>'trade_id', 'includeRosterPreview', false))->'trade' ORDER BY ordinal), '[]')
  INTO rows FROM jsonb_array_elements(refs) WITH ORDINALITY refs(ref, ordinal) WHERE ordinal <= page_size;
  IF has_more THEN next_cursor := jsonb_build_object('token', refs->(page_size - 1)->>'cursor_token'); END IF;
  RETURN jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor,
    'pendingIncomingCount', public.get_pending_trade_count(p_member_id, p_league_id),
    'block', public.view_trade_block(p_league_id, p_member_id, p_params)->'block',
    'members', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'team_name', team_name, 'role', role) ORDER BY id)
      FROM public.league_members WHERE league_id = p_league_id), '[]'));
END;
$$;

REVOKE ALL ON FUNCTION public.view_trades(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_trades(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_trade_analysis(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT public.view_trade_details(p_league_id, p_member_id, p_params || '{"includeRosterPreview":false}');
$$;

REVOKE ALL ON FUNCTION public.view_trade_analysis(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_trade_analysis(uuid,uuid,jsonb) TO authenticated;

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

REVOKE ALL ON FUNCTION public.view_draft_rooms(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_draft_rooms(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_draft_room(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; draft public.drafts%ROWTYPE; orders jsonb; budgets jsonb; nominations jsonb; picks jsonb;
  open_nomination jsonb; active_bids jsonb; current_member uuid;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO draft FROM public.drafts WHERE id = (p_params->>'draftId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'draft', NULL); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('position', entry.position, 'memberId', entry.member_id,
    'teamName', COALESCE(member.team_name, 'Unknown')) ORDER BY entry.position), '[]') INTO orders
    FROM public.draft_orders entry LEFT JOIN public.league_members member ON member.id = entry.member_id WHERE entry.draft_id = draft.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', budget.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'remaining', budget.remaining, 'initialBudget', budget.initial_budget) ORDER BY budget.member_id), '[]') INTO budgets
    FROM public.draft_budgets budget LEFT JOIN public.league_members member ON member.id = budget.member_id WHERE budget.draft_id = draft.id;
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
    'nextPick', (SELECT item FROM jsonb_array_elements(picks) item WHERE item->>'player' IS NULL AND item->>'skippedAt' IS NULL LIMIT 1));
END;
$$;

REVOKE ALL ON FUNCTION public.view_draft_room(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_draft_room(uuid,uuid,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_league(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  CASE COALESCE(p_params->>'tab', 'results')
    WHEN 'results' THEN RETURN public.view_standings(p_league_id, p_member_id, p_params);
    WHEN 'history' THEN RETURN public.view_activity(p_league_id, p_member_id, p_params);
    WHEN 'picks' THEN RETURN public.view_picks(p_league_id, p_member_id, p_params);
    WHEN 'draftBoard' THEN RETURN public.view_picks(p_league_id, p_member_id, p_params);
    WHEN 'settings' THEN RETURN public.view_settings(p_league_id, p_member_id, p_params);
    WHEN 'draft' THEN RETURN public.view_draft_rooms(p_league_id, p_member_id, p_params);
    WHEN 'mockRooms' THEN RETURN public.view_draft_rooms(p_league_id, p_member_id, p_params);
    ELSE RAISE EXCEPTION 'Unknown league tab.' USING ERRCODE = '22023';
  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION public.view_league(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_league(uuid,uuid,jsonb) TO authenticated;
