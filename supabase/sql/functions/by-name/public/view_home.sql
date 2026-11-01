-- Canonical SQL source for public.view_home.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_home(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; matchup public.matchups%ROWTYPE; opponent uuid; subject uuid; selected date;
  requested_week integer := (p_params->>'weekNumber')::integer;
  mine jsonb; theirs jsonb; records jsonb; matchup_data jsonb; league_matchups jsonb; announcements jsonb; league_today date; league_week integer; basis jsonb;
  payload jsonb; lineup_key text; compact_groups jsonb;
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
    WHERE member.id = subject;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'homeMemberId', m.home_member_id, 'awayMemberId', m.away_member_id,
    'homeTeamName', COALESCE(home.team_name, 'Home'), 'awayTeamName', COALESCE(away.team_name, 'Away'),
    'homePoints', m.home_points, 'awayPoints', m.away_points, 'isFinalized', m.is_finalized,
    'isMine', p_member_id IN (m.home_member_id, m.away_member_id)) ORDER BY p_member_id IN (m.home_member_id, m.away_member_id) DESC,
      GREATEST(COALESCE(m.home_points, 0), COALESCE(m.away_points, 0)) DESC, m.id), '[]')
  INTO league_matchups FROM public.matchups m JOIN public.league_members home ON home.id = m.home_member_id
    JOIN public.league_members away ON away.id = m.away_member_id
  WHERE m.league_id = p_league_id AND m.league_season_id = matchup.league_season_id AND NOT m.is_voided
    AND m.week_number <= (context->>'weekNumber')::integer AND COALESCE(m.end_week_number, m.week_number) >= (context->>'weekNumber')::integer;
  basis := CASE WHEN selected=league_today THEN private.live_score_basis(p_league_id,matchup.league_season_id,
    (context->>'weekNumber')::integer,selected,matchup.id) ELSE '[]'::jsonb END;
  IF p_params->>'compact'='true' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'id',item->'homeMemberId',item->'awayMemberId',item->'homePoints',
      item->'awayPoints',item->'finalized',item->'ready',(SELECT COALESCE(jsonb_agg(jsonb_build_array(player->'playerId',
        CASE WHEN player->>'memberId'=item->>'homeMemberId' THEN 0 ELSE 1 END,player->'nbaId',player->'espnId',player->'team',
        player->'gameId',player->'savedPoints',player->'savedAt',player->'starter',player->'final')),'[]'::jsonb)
        FROM jsonb_array_elements(item->'players') player))),'[]'::jsonb)
    INTO basis FROM jsonb_array_elements(basis) item;
    context := (context-'member'-'season') || jsonb_build_object('league',jsonb_build_object('id',p_league_id,
      'timezone',context->'league'->'timezone','scoring_settings',context->'league'->'scoring_settings'));
  END IF;
  payload := jsonb_build_object('context', context, 'matchup', matchup_data, 'weekDays', mine->'weekDays', 'selectedDate', selected,
    'leagueMatchups', league_matchups, 'myLineup', mine - ARRAY['context','date','weekDays','games','optimizer','startedTeams','teamMatchups','liveStats'],
    'oppLineup', theirs - ARRAY['context','date','weekDays','games','optimizer','startedTeams','teamMatchups','liveStats'],
    'forecast', public.get_matchup_forecast(matchup.id), 'announcements', announcements, 'todaysGames', mine->'games',
    'liveStats', (mine->'liveStats') || (theirs->'liveStats'), 'startedTeams', mine->'startedTeams', 'teamMatchups', mine->'teamMatchups',
    'liveBasis',basis);
  IF p_params->>'compact'='true' THEN
    FOREACH lineup_key IN ARRAY ARRAY['myLineup','oppLineup'] LOOP
      WITH groups AS (SELECT key,value FROM jsonb_each(payload->lineup_key) WHERE key IN ('starters','bench','ir','taxi')),
      rows AS (SELECT key,item,ordinality,CASE WHEN key='starters' THEN item->'player' ELSE item END AS player
        FROM groups CROSS JOIN LATERAL jsonb_array_elements(value) WITH ORDINALITY AS entry(item,ordinality)),
      packed AS (SELECT key,item,ordinality,CASE WHEN player IS NULL OR player='null'::jsonb THEN 'null'::jsonb
        ELSE jsonb_build_array(player->'rosterPlayerId',player->'playerId',player->'displayName',player->'position',
          player->'eligiblePositions',player->'nbaTeam',player->'yearsExp',player->'careerGames',player->'injuryStatus',
          player->'nbaId',player->'espnId',player->'assetLocks') END AS player FROM rows),
      combined AS (SELECT key,jsonb_agg(CASE WHEN key='starters' THEN jsonb_build_array(item->'slotType',player)
        ELSE player END ORDER BY ordinality) AS value FROM packed GROUP BY key)
      SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO compact_groups FROM combined;
      payload:=jsonb_set(payload,ARRAY[lineup_key],((payload->lineup_key)-'lockedAssets')||compact_groups);
    END LOOP;
    SELECT COALESCE(jsonb_object_agg(key,jsonb_build_array(value->'points',value->'rebounds',value->'assists',value->'steals',
      value->'blocks',value->'turnovers',value->'threeMade',value->'fgMade',value->'fgAttempted',value->'ftMade',
      value->'ftAttempted',value->'fouls',value->'doubleDouble',value->'tripleDouble',value->'minutesPlayed',value->'didNotPlay')),'{}'::jsonb)
      INTO compact_groups FROM jsonb_each(payload->'liveStats');
    payload:=payload||jsonb_build_object('wireVersion',1,'liveStats',compact_groups);
    IF payload->'forecast'<>'null'::jsonb THEN
      payload:=jsonb_set(payload,'{forecast}',jsonb_build_object('stale',payload->'forecast'->'stale',
        'tieProbability',payload->'forecast'->'tieProbability','missingInputs',COALESCE((
          SELECT jsonb_agg(value) FROM jsonb_array_elements_text(payload->'forecast'->'missingInputs') value
          WHERE value LIKE 'Projection substituted:%'),'[]'::jsonb),
        'teams',COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId',team->'memberId','projectedFinal',team->'projectedFinal',
          'currentPoints',team->'currentPoints','winProbability',team->'winProbability'))
          FROM jsonb_array_elements(payload->'forecast'->'teams') team),'[]'::jsonb),
        'games',COALESCE((SELECT jsonb_agg(jsonb_build_object('gameId',game->'gameId','playerId',game->'playerId','memberId',game->'memberId'))
          FROM jsonb_array_elements(payload->'forecast'->'games') game WHERE payload->'forecast'->'missingInputs'
            @>jsonb_build_array('Projection substituted: '||(game->>'playerId')||':'||(game->>'gameId'))),'[]'::jsonb)));
    END IF;
  END IF;
  RETURN payload;
END;
$$;
