CREATE OR REPLACE FUNCTION private.live_score_basis(p_league_id uuid, p_season_id uuid, p_week integer, p_date date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH matches AS MATERIALIZED (
    SELECT m.* FROM public.matchups m WHERE m.league_id=p_league_id AND m.league_season_id=p_season_id
      AND NOT m.is_voided AND m.week_number<=p_week AND COALESCE(m.end_week_number,m.week_number)>=p_week
  ), members AS MATERIALIZED (
    SELECT id, home_member_id AS member_id FROM matches UNION ALL SELECT id, away_member_id FROM matches
  ), totals AS MATERIALIZED (
    SELECT m.id, member.member_id, COALESCE(sum(public.compute_fantasy_points(stat.id,p_league_id)),0) AS points
    FROM matches m JOIN members member ON member.id=m.id
    LEFT JOIN public.weekly_lineups lineup ON lineup.league_id=p_league_id AND lineup.league_season_id=p_season_id
      AND lineup.member_id=member.member_id AND lineup.week_number BETWEEN m.week_number AND COALESCE(m.end_week_number,m.week_number)
      AND lineup.slot_type NOT IN ('BE','IR')
    LEFT JOIN public.league_seasons season ON season.id=p_season_id
    LEFT JOIN public.season_weeks week ON week.season_year=season.season_year AND week.week_number=lineup.week_number
    LEFT JOIN public.player_game_stats stat ON stat.player_id=lineup.player_id AND stat.game_date=lineup.game_date
      AND stat.season_year=season.season_year AND stat.game_date BETWEEN week.week_start AND week.week_end
    GROUP BY m.id,member.member_id
  ), players AS MATERIALIZED (
    SELECT member.id,member.member_id,lineup.player_id,true AS starter FROM members member
      JOIN public.weekly_lineups lineup ON lineup.member_id=member.member_id AND lineup.league_id=p_league_id
        AND lineup.league_season_id=p_season_id AND lineup.game_date=p_date AND lineup.slot_type NOT IN ('BE','IR')
    UNION ALL
    SELECT member.id,member.member_id,roster.player_id,false FROM members member
      JOIN public.roster_players roster ON roster.member_id=member.member_id AND roster.league_id=p_league_id
        AND roster.league_season_id=p_season_id
      WHERE NOT EXISTS(SELECT 1 FROM public.weekly_lineups lineup WHERE lineup.member_id=member.member_id
        AND lineup.league_id=p_league_id AND lineup.league_season_id=p_season_id AND lineup.game_date=p_date
        AND lineup.player_id=roster.player_id AND lineup.slot_type NOT IN ('BE','IR'))
  ), memberships AS MATERIALIZED (
    SELECT membership.* FROM private.player_game_memberships membership JOIN public.nba_games game ON game.id=membership.game_id
      WHERE game.game_date=p_date
  ), lines AS MATERIALIZED (
    SELECT selected.id,jsonb_agg(jsonb_build_object('playerId',player.id,'memberId',selected.member_id,
      'nbaId',player.nba_id,'espnId',player.espn_id,'team',COALESCE(membership.nba_team,player.nba_team),
      'gameId',game.nba_game_id,'savedPoints',public.compute_fantasy_points(stat.id,p_league_id),
      'savedAt',COALESCE(extract(epoch FROM feed.stats_updated_at)*1000,0),'starter',selected.starter,
      'final',game.status='Final' AND game.stats_synced_at IS NOT NULL) ORDER BY selected.member_id,player.id,game.id) AS data
    FROM players selected JOIN public.players player ON player.id=selected.player_id
    LEFT JOIN public.league_seasons season ON season.id=p_season_id
    LEFT JOIN memberships membership ON membership.player_id=player.id
    LEFT JOIN public.nba_games game ON game.game_date=p_date AND game.season_year=season.season_year
      AND public.is_regular_season_game_id(game.nba_game_id)
      AND (game.id=membership.game_id OR membership.game_id IS NULL AND player.nba_team IN (game.home_team,game.away_team))
    LEFT JOIN public.player_game_stats stat ON stat.player_id=player.id AND stat.game_id=game.id
    LEFT JOIN private.live_feed_state feed ON feed.game_id=game.id
    GROUP BY selected.id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'homeMemberId',m.home_member_id,'awayMemberId',m.away_member_id,
    'homePoints',COALESCE(m.home_points,0),'awayPoints',COALESCE(m.away_points,0),'finalized',COALESCE(m.is_finalized,false),
    'ready',COALESCE(m.home_points,0)=home.points AND COALESCE(m.away_points,0)=away.points,
    'players',COALESCE(lines.data,'[]'::jsonb)) ORDER BY m.id),'[]'::jsonb)
  FROM matches m JOIN totals home ON home.id=m.id AND home.member_id=m.home_member_id
    JOIN totals away ON away.id=m.id AND away.member_id=m.away_member_id LEFT JOIN lines ON lines.id=m.id;
$$;

ALTER FUNCTION private.live_score_basis(uuid,uuid,integer,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.live_score_basis(uuid,uuid,integer,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.view_home(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; matchup public.matchups%ROWTYPE; opponent uuid; subject uuid; selected date;
  requested_week integer := (p_params->>'weekNumber')::integer;
  mine jsonb; theirs jsonb; records jsonb; matchup_data jsonb; league_matchups jsonb; announcements jsonb; league_today date; league_week integer;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  league_today := (now() AT TIME ZONE COALESCE(context->'league'->>'timezone', 'America/Los_Angeles'))::date;
  SELECT week_number INTO league_week FROM public.season_weeks WHERE season_year = (context->>'seasonYear')::integer
    ORDER BY CASE WHEN league_today BETWEEN week_start AND week_end THEN 0 WHEN week_start > league_today THEN 1 ELSE 2 END,
      CASE WHEN week_start >= league_today THEN week_start END, week_end DESC LIMIT 1;
  context := context || jsonb_build_object('today', league_today, 'weekNumber', COALESCE((p_params->>'weekNumber')::integer, league_week));
  p_params := p_params || jsonb_build_object('weekNumber', context->'weekNumber');
  SELECT COALESCE(jsonb_agg(to_jsonb(row)), '[]') INTO announcements FROM (SELECT * FROM public.notif_list_announcements(p_league_id) item
    WHERE item.author_member_id IS DISTINCT FROM p_member_id AND item.published_at >= now() - interval '14 days' LIMIT 5) row;
  IF p_params->>'matchupId' IS NOT NULL THEN
    SELECT * INTO matchup FROM public.matchups WHERE id=(p_params->>'matchupId')::uuid
      AND league_id=p_league_id AND league_season_id=(context->>'seasonId')::uuid AND NOT is_voided;
    IF NOT FOUND THEN RAISE EXCEPTION 'This matchup is not available.' USING ERRCODE='42501'; END IF;
    context := context || jsonb_build_object('weekNumber',COALESCE(requested_week,matchup.week_number));
    p_params := p_params || jsonb_build_object('weekNumber',context->'weekNumber');
  ELSE
    SELECT * INTO matchup FROM public.matchups WHERE league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
    AND NOT is_voided AND p_member_id IN (home_member_id, away_member_id) AND week_number <= (context->>'weekNumber')::integer
    AND COALESCE(end_week_number, week_number) >= (context->>'weekNumber')::integer
    AND (context->'season'->>'is_current')::boolean ORDER BY week_number DESC, id LIMIT 1;
  END IF;
  IF matchup.id IS NULL THEN RETURN jsonb_build_object('context', context, 'matchup', NULL, 'weekDays', '[]'::jsonb,
    'leagueMatchups', '[]'::jsonb, 'myLineup', NULL, 'oppLineup', NULL, 'forecast', NULL, 'announcements', announcements,
    'todaysGames', '[]'::jsonb, 'liveStats', '{}'::jsonb, 'startedTeams', '[]'::jsonb, 'teamMatchups', '{}'::jsonb,
    'selectedDate', COALESCE(p_params->>'date', context->>'today')); END IF;
  subject := CASE WHEN p_member_id IN (matchup.home_member_id,matchup.away_member_id) THEN p_member_id ELSE matchup.home_member_id END;
  opponent := CASE WHEN matchup.home_member_id = subject THEN matchup.away_member_id ELSE matchup.home_member_id END;
  selected := COALESCE((p_params->>'date')::date, (context->>'today')::date);
  SELECT GREATEST(LEAST(selected, week_end), CASE WHEN week_number = 1 THEN date_trunc('week', week_start::timestamp)::date ELSE week_start END)
    INTO selected FROM public.season_weeks WHERE season_year = (context->>'seasonYear')::integer AND week_number = (context->>'weekNumber')::integer;
  mine := public.view_lineup(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected,'targetMemberId',subject));
  theirs := public.view_lineup(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected, 'targetMemberId', opponent));
  records := public.view_standings(p_league_id, p_member_id, p_params)->'standings';
  SELECT jsonb_build_object('id', matchup.id, 'weekNumber', (context->>'weekNumber')::integer,
    'roundStartWeek', matchup.week_number, 'roundEndWeek', COALESCE(matchup.end_week_number, matchup.week_number),
    'myPoints', CASE WHEN matchup.home_member_id = subject THEN matchup.home_points ELSE matchup.away_points END,
    'opponentPoints', CASE WHEN matchup.home_member_id = subject THEN matchup.away_points ELSE matchup.home_points END,
    'myTeamName', COALESCE(member.team_name, 'My Team'), 'opponentTeamName', COALESCE(other.team_name, 'Opponent'),
    'myUsername', COALESCE(profile.display_name, ''), 'opponentUsername', COALESCE(other_profile.display_name, ''),
    'myWins', COALESCE((SELECT row->'wins' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = subject::text), '0'),
    'myLosses', COALESCE((SELECT row->'losses' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = subject::text), '0'),
    'opponentWins', COALESCE((SELECT row->'wins' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = opponent::text), '0'),
    'opponentLosses', COALESCE((SELECT row->'losses' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = opponent::text), '0'),
    'isFinalized', matchup.is_finalized, 'iWon', CASE WHEN matchup.winner_member_id IS NOT NULL THEN matchup.winner_member_id = subject END,
    'myMemberId', subject, 'opponentMemberId', opponent, 'seasonId', matchup.league_season_id, 'seasonYear', (context->>'seasonYear')::integer)
  INTO matchup_data FROM public.league_members member JOIN public.league_members other ON other.id = opponent
    LEFT JOIN public.profiles profile ON profile.id = member.user_id LEFT JOIN public.profiles other_profile ON other_profile.id = other.user_id
    LEFT JOIN public.matchup_totals totals ON totals.matchup_id = matchup.id WHERE member.id = subject;
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
    'liveStats', (mine->'liveStats') || (theirs->'liveStats'), 'startedTeams', mine->'startedTeams', 'teamMatchups', mine->'teamMatchups',
    'liveBasis',CASE WHEN selected=league_today THEN private.live_score_basis(p_league_id,matchup.league_season_id,
      (context->>'weekNumber')::integer,selected) ELSE '[]'::jsonb END);
END;
$$;

CREATE OR REPLACE FUNCTION public.view_lineup(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
      'assetLocks', '[]'::jsonb, 'playerId', p.id, 'displayName', COALESCE(p.display_name, ''), 'position', p.position,
      'eligiblePositions', CASE WHEN cardinality(p.eligible_positions) > 0 THEN to_jsonb(p.eligible_positions)
        WHEN p.position IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.position) END,
      'nbaTeam', p.nba_team, 'yearsExp', p.years_exp, 'careerGames', p.career_regular_season_games,
      'injuryStatus', p.injury_status, 'nbaId', p.nba_id, 'espnId', p.espn_id) AS data
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
  RETURN jsonb_build_object('lockedAssets', '[]'::jsonb, 'context', context, 'date', selected, 'starters', starters, 'bench', bench, 'ir', ir, 'taxi', taxi,
    'benchSlots', COALESCE((SELECT slot_count FROM public.lineup_slot_templates WHERE league_id = p_league_id AND slot_type = 'BE'), 0),
    'weekDays', days, 'games', game_day->'games', 'startedTeams', game_day->'startedTeams', 'teamMatchups', game_day->'teamMatchups', 'liveStats', game_day->'liveStats',
    'optimizer', (SELECT to_jsonb(settings) FROM public.lineup_optimizer_settings settings
      WHERE settings.member_id = p_member_id AND settings.league_season_id = (context->>'seasonId')::uuid));
END;
$$;

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
      'game_status_text', game_status_text, 'game_date', game_date, 'game_time',game_time) ORDER BY game_time, id) FROM slate WHERE nba_game_id LIKE '002%'), '[]'),
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
