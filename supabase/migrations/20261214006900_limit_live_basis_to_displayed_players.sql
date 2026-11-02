CREATE OR REPLACE FUNCTION private.live_score_basis(p_league_id uuid, p_season_id uuid, p_week integer, p_date date, p_detail_matchup_id uuid)
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
      WHERE member.id=p_detail_matchup_id AND NOT EXISTS(SELECT 1 FROM public.weekly_lineups lineup WHERE lineup.member_id=member.member_id
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
ALTER FUNCTION private.live_score_basis(uuid,uuid,integer,date,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.live_score_basis(uuid,uuid,integer,date,uuid) FROM PUBLIC,anon,authenticated,service_role;

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
      (context->>'weekNumber')::integer,selected,matchup.id) ELSE '[]'::jsonb END);
END;
$$;

DROP FUNCTION private.live_score_basis(uuid,uuid,integer,date);
