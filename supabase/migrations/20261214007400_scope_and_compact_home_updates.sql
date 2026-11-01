BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION private.league_version_capture()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed_sql text; leagues_sql text; affected record;
  ignored text[] := ARRAY['updated_at','set_at'];
  home_changes jsonb; home_changed boolean;
BEGIN
  IF TG_TABLE_NAME IN ('standings_current','matchup_totals','player_season_averages','trade_value_cache') THEN
    ignored := ignored||ARRAY['version','refreshed_at'];
  END IF;
  IF TG_TABLE_NAME='profiles' THEN ignored := ignored||ARRAY['push_token','push_token_revocation_hash']; END IF;
  IF TG_TABLE_NAME='nba_games' THEN
    ignored := ignored||ARRAY['live_stats_elapsed_seconds','live_scoreboard_elapsed_seconds','stats_synced_at'];
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM version_new_rows) THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM version_old_rows) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS(
      (SELECT to_jsonb(n)-ignored FROM version_new_rows n EXCEPT SELECT to_jsonb(o)-ignored FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-ignored FROM version_old_rows o EXCEPT SELECT to_jsonb(n)-ignored FROM version_new_rows n)) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='standings_current' THEN
    home_changed:=true;
    IF TG_OP='UPDATE' THEN
      SELECT EXISTS(
        (SELECT jsonb_build_array(n.member_id,n.league_season_id,n.wins,n.losses) FROM version_new_rows n
          EXCEPT SELECT jsonb_build_array(o.member_id,o.league_season_id,o.wins,o.losses) FROM version_old_rows o)
        UNION ALL
        (SELECT jsonb_build_array(o.member_id,o.league_season_id,o.wins,o.losses) FROM version_old_rows o
          EXCEPT SELECT jsonb_build_array(n.member_id,n.league_season_id,n.wins,n.losses) FROM version_new_rows n)
      ) INTO home_changed;
    END IF;
    home_changes:=COALESCE(NULLIF(current_setting('pancake.home_changes',true),'')::jsonb,'{}'::jsonb);
    PERFORM set_config('pancake.home_changes',jsonb_set(home_changes,ARRAY[TG_TABLE_NAME],
      to_jsonb(COALESCE((home_changes->>TG_TABLE_NAME)::boolean,false) OR home_changed))::text,true);
  END IF;
  IF TG_OP='INSERT' THEN changed_sql := 'SELECT to_jsonb(n) AS data FROM version_new_rows n';
  ELSIF TG_OP='DELETE' THEN changed_sql := 'SELECT to_jsonb(o) AS data FROM version_old_rows o';
  ELSE
    changed_sql := format($rows$
      (SELECT to_jsonb(n)-%L::text[] AS data FROM version_new_rows n
       EXCEPT SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o
       EXCEPT SELECT to_jsonb(n)-%L::text[] FROM version_new_rows n)
    $rows$,ignored,ignored,ignored,ignored);
  END IF;
  CASE TG_ARGV[1]
    WHEN 'league' THEN leagues_sql := 'SELECT (data->>''league_id'')::uuid AS league_id FROM changed';
    WHEN 'user' THEN leagues_sql := 'SELECT member.league_id FROM changed JOIN public.league_members member ON member.user_id=COALESCE((data->>''user_id'')::uuid,(data->>''id'')::uuid)';
    WHEN 'self' THEN leagues_sql := 'SELECT (data->>''id'')::uuid AS league_id FROM changed';
    WHEN 'draft' THEN leagues_sql := 'SELECT draft.league_id FROM changed JOIN public.drafts draft ON draft.id=(data->>''draft_id'')::uuid';
    WHEN 'trade' THEN leagues_sql := 'SELECT trade.league_id FROM changed JOIN public.trades trade ON trade.id=(data->>''trade_id'')::uuid';
    WHEN 'season' THEN leagues_sql := 'SELECT season.league_id FROM changed JOIN public.league_seasons season ON season.season_year=(data->>''season_year'')::integer';
    WHEN 'global' THEN leagues_sql := 'SELECT league.id AS league_id FROM public.leagues league WHERE league.deleted_at IS NULL AND EXISTS(SELECT 1 FROM changed)';
    ELSE RAISE EXCEPTION 'Unsupported league version source: %',TG_TABLE_NAME;
  END CASE;
  FOR affected IN EXECUTE format('WITH changed AS (%s) SELECT DISTINCT league_id FROM (%s) affected WHERE league_id IS NOT NULL ORDER BY league_id',changed_sql,leagues_sql) LOOP
    PERFORM private.league_version_enqueue(affected.league_id,TG_ARGV[0],TG_TABLE_NAME);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.publish_league_version(p_league_id uuid,p_topics text[],p_sources text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE stored public.league_versions%ROWTYPE; readers uuid[]; change_topic text; change_scope jsonb;
BEGIN
    PERFORM 1 FROM public.league_versions WHERE league_id=p_league_id FOR UPDATE;
    SELECT CASE WHEN league.deleted_at IS NULL
      THEN ARRAY(SELECT member.user_id FROM public.league_members member WHERE member.league_id=league.id ORDER BY member.user_id)
      ELSE ARRAY[]::uuid[] END INTO readers FROM public.leagues league WHERE league.id=p_league_id;
    IF NOT FOUND THEN RETURN; END IF;
    INSERT INTO public.league_versions AS current(league_id,version,reader_ids)
      VALUES(p_league_id,1,readers)
    ON CONFLICT(league_id) DO UPDATE SET version=current.version+1,updated_at=clock_timestamp(),reader_ids=EXCLUDED.reader_ids
    RETURNING league_id,version,updated_at,reader_ids INTO stored;
    change_topic := CASE WHEN cardinality(p_topics)=1 THEN p_topics[1] ELSE 'batch' END;
    change_scope := jsonb_build_object('topics',p_topics,'tables',p_sources);
    IF cardinality(p_sources)>0 AND p_sources<@ARRAY['standings_current','matchup_totals','player_season_averages']::text[]
      AND (NOT 'standings_current'=ANY(p_sources)
        OR COALESCE(NULLIF(current_setting('pancake.home_changes',true),'')::jsonb->>'standings_current','true')='false') THEN
      change_scope:=change_scope||jsonb_build_object('homeChanged',false);
    END IF;
    change_scope := change_scope || jsonb_build_object('hints',COALESCE((
      SELECT CASE WHEN count(*)<=32 THEN jsonb_agg(item ORDER BY item::text) ELSE '[]'::jsonb END FROM (
        SELECT DISTINCT jsonb_build_object('topic',hint->'row'->'topic','scopes',hint->'row'->'scopes',
          'details',hint->'row'->'details') AS item
        FROM private.live_hint_broadcasts pending CROSS JOIN LATERAL jsonb_array_elements(pending.changes) hint
        WHERE pending.transaction_id=pg_current_xact_id() AND pending.topic='l1:league:'||p_league_id::text
          AND hint->'row'->>'topic'<>'version') scoped),'[]'::jsonb));
    INSERT INTO public.league_changes(league_id,version,topic,scope,created_at)
      VALUES(stored.league_id,stored.version,change_topic,change_scope,stored.updated_at);
    DELETE FROM public.league_changes WHERE league_id=stored.league_id AND version<=stored.version-128;
    INSERT INTO public.league_change_hints AS hint(league_id,topic,revision,scopes,details,updated_at)
      VALUES(stored.league_id,'version',stored.version,NULL,jsonb_build_array(jsonb_build_object(
        'version',stored.version::text,'topic',change_topic,'scope',change_scope,'created_at',stored.updated_at)),stored.updated_at)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=EXCLUDED.revision,scopes=NULL,details=EXCLUDED.details,updated_at=EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION private.flush_player_stats_hints()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF coalesce(current_setting('request.headers',true),'')=''
    AND NOT EXISTS(SELECT 1 FROM private.player_stats_hint_pending) THEN RETURN 0; END IF;
  WITH ready AS MATERIALIZED (
    SELECT pending.league_id FROM private.player_stats_hint_pending pending
    WHERE NOT EXISTS(SELECT 1 FROM public.league_change_hints hint
      WHERE hint.league_id=pending.league_id AND hint.topic='score'
        AND hint.updated_at>clock_timestamp()-interval '1 minute')
    ORDER BY pending.league_id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ), emitted AS (
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details,updated_at)
    SELECT ready.league_id,'score',1,NULL,(SELECT jsonb_agg(jsonb_build_object('resource','averages','season_id',season.id))
      FROM public.league_seasons season WHERE season.league_id=ready.league_id AND season.is_current),clock_timestamp() FROM ready
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp()
    WHERE stored.updated_at<=clock_timestamp()-interval '1 minute'
    RETURNING league_id
  ) DELETE FROM private.player_stats_hint_pending WHERE league_id IN (SELECT league_id FROM emitted);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;

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

COMMIT;
