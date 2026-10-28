SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE TABLE private.trade_value_publications(
  trade_id uuid PRIMARY KEY REFERENCES public.trade_value_cache(trade_id) ON DELETE CASCADE,
  version bigint NOT NULL,
  valid_until timestamptz NOT NULL
);
ALTER TABLE private.trade_value_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.trade_value_publications FROM PUBLIC,anon,authenticated;
GRANT ALL ON private.trade_value_publications TO service_role;
INSERT INTO private.trade_value_publications(trade_id,version,valid_until)
  SELECT trade_id,version,valid_until FROM public.trade_value_cache;
INSERT INTO private.retention_rules(relation_name,retention_rule)
  VALUES('private.trade_value_publications','One publication per cached trade; deletion cascades from the cache');
ALTER TABLE private.trade_value_publications SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02);

CREATE OR REPLACE FUNCTION private.refresh_standings(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.standings_current AS cached(league_id, league_season_id, member_id, team_name, wins, losses, ties, points_for, points_against, max_points_for, version)
  SELECT p_league_id, p_season_id, member.id, COALESCE(member.team_name, 'Team'),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id = member.id),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id IS NOT NULL AND matchup.winner_member_id <> member.id),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id IS NULL),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.home_points ELSE matchup.away_points END), 0),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.away_points ELSE matchup.home_points END), 0),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points ELSE matchup.away_max_possible_points END), 0), p_version
  FROM public.league_members member
  LEFT JOIN public.matchups matchup ON matchup.league_id = p_league_id AND matchup.league_season_id = p_season_id
    AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    AND matchup.is_finalized AND NOT matchup.is_voided AND matchup.matchup_type = 'regular_season'
  WHERE member.league_id = p_league_id GROUP BY member.id
  ON CONFLICT (league_season_id, member_id) DO UPDATE SET team_name = EXCLUDED.team_name,
    wins = EXCLUDED.wins, losses = EXCLUDED.losses, ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for, points_against = EXCLUDED.points_against, max_points_for = EXCLUDED.max_points_for,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version
      AND (md5((to_jsonb(cached)-ARRAY['version','refreshed_at'])::text)
        IS DISTINCT FROM md5((to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at'])::text)
        OR (to_jsonb(cached)-ARRAY['version','refreshed_at'])
          IS DISTINCT FROM (to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at']));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_matchup_totals(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.matchup_totals AS cached(matchup_id, league_id, league_season_id, home_points, away_points, home_max_possible_points, away_max_possible_points, version)
  SELECT id, league_id, league_season_id, home_points, away_points, home_max_possible_points, away_max_possible_points, p_version
  FROM public.matchups WHERE league_id = p_league_id AND league_season_id = p_season_id AND NOT is_voided
  ON CONFLICT (matchup_id) DO UPDATE SET home_points = EXCLUDED.home_points, away_points = EXCLUDED.away_points,
    home_max_possible_points = EXCLUDED.home_max_possible_points, away_max_possible_points = EXCLUDED.away_max_possible_points,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version
      AND (md5((to_jsonb(cached)-ARRAY['version','refreshed_at'])::text)
        IS DISTINCT FROM md5((to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at'])::text)
        OR (to_jsonb(cached)-ARRAY['version','refreshed_at'])
          IS DISTINCT FROM (to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at']));
  DELETE FROM public.matchup_totals cached WHERE cached.league_season_id = p_season_id AND cached.version < p_version
    AND NOT EXISTS (SELECT 1 FROM public.matchups matchup WHERE matchup.id = cached.matchup_id AND NOT matchup.is_voided);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_player_averages(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_year integer;
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT season.season_year INTO STRICT selected_year FROM public.league_seasons season WHERE season.id = p_season_id;
  INSERT INTO public.player_season_averages AS cached(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
  SELECT p_league_id, p_season_id, selected_year, COALESCE(average.player_id, fantasy.player_id), to_jsonb(average), fantasy.avg_fantasy_points, p_version
  FROM (SELECT * FROM public.mv_player_season_averages average WHERE average.season_year = selected_year) average
  FULL JOIN (SELECT * FROM public.v_player_avg_fantasy_points fantasy WHERE fantasy.league_id = p_league_id AND fantasy.season_year = selected_year) fantasy
    ON fantasy.player_id = average.player_id
  ON CONFLICT (league_id, season_year, player_id) DO UPDATE SET averages = EXCLUDED.averages, avg_fantasy_points = EXCLUDED.avg_fantasy_points,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version
      AND (md5((to_jsonb(cached)-ARRAY['version','refreshed_at'])::text)
        IS DISTINCT FROM md5((to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at'])::text)
        OR (to_jsonb(cached)-ARRAY['version','refreshed_at'])
          IS DISTINCT FROM (to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at']));
  DELETE FROM public.player_season_averages cached WHERE cached.league_season_id = p_season_id
    AND NOT EXISTS(SELECT 1 FROM public.mv_player_season_averages source
      WHERE source.season_year=selected_year AND source.player_id=cached.player_id)
    AND NOT EXISTS(SELECT 1 FROM public.v_player_avg_fantasy_points source
      WHERE source.league_id=p_league_id AND source.season_year=selected_year AND source.player_id=cached.player_id);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_trade_values(p_league_id uuid, p_season_id uuid, p_version bigint, p_values jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Trade values must be an array.' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.trade_value_cache AS cached(trade_id, league_id, league_season_id, revaluation, valid_until, version)
  SELECT trade.id, p_league_id, p_season_id, item->'revaluation',
    LEAST(now() + interval '10 minutes', COALESCE((item->'revaluation'->>'expiresAt')::timestamptz, now() + interval '10 minutes')), p_version
  FROM jsonb_array_elements(p_values) item
  JOIN public.trades trade ON trade.id = (item->>'tradeId')::uuid AND trade.league_id = p_league_id AND trade.league_season_id = p_season_id
  WHERE jsonb_typeof(item->'revaluation') = 'object'
  ON CONFLICT (trade_id) DO UPDATE SET revaluation = CASE
      WHEN md5(cached.revaluation::text)=md5(EXCLUDED.revaluation::text)
        AND cached.revaluation=EXCLUDED.revaluation THEN cached.revaluation ELSE EXCLUDED.revaluation END,
    valid_until = EXCLUDED.valid_until,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version
      AND (md5(cached.revaluation::text) IS DISTINCT FROM md5(EXCLUDED.revaluation::text)
        OR cached.revaluation IS DISTINCT FROM EXCLUDED.revaluation);
  INSERT INTO private.trade_value_publications AS published(trade_id,version,valid_until)
  SELECT trade.id,p_version,
    LEAST(now() + interval '10 minutes', COALESCE((item->'revaluation'->>'expiresAt')::timestamptz,now() + interval '10 minutes'))
  FROM jsonb_array_elements(p_values) item
  JOIN public.trades trade ON trade.id=(item->>'tradeId')::uuid
    AND trade.league_id=p_league_id AND trade.league_season_id=p_season_id
  WHERE jsonb_typeof(item->'revaluation')='object'
  ON CONFLICT(trade_id) DO UPDATE SET version=EXCLUDED.version,valid_until=EXCLUDED.valid_until
    WHERE published.version<EXCLUDED.version;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_screen_views(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  ORDER BY season.id ON CONFLICT DO NOTHING;
  UPDATE private.screen_refresh_queue queued SET version = version + 1, dirty = true, available_at = p_now, changed_at = p_now
  WHERE NOT queued.dirty AND EXISTS (
    SELECT 1 FROM public.trade_value_cache cached JOIN private.trade_value_publications published USING(trade_id)
      WHERE cached.league_season_id = queued.league_season_id AND published.valid_until <= p_now);
  IF EXISTS (SELECT 1 FROM private.screen_refresh_queue WHERE dirty AND available_at <= p_now
    AND (claimed_at IS NULL OR claimed_at < p_now - interval '3 minutes')) THEN
    PERFORM private.work_enqueue('refresh-views',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_dispatch_screen_views()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  ORDER BY season.id ON CONFLICT DO NOTHING;
  UPDATE private.screen_refresh_queue queued SET version = version + 1, dirty = true, available_at = now(), changed_at = now()
  WHERE NOT queued.dirty AND EXISTS (
    SELECT 1 FROM public.trade_value_cache cached JOIN private.trade_value_publications published USING(trade_id)
      WHERE cached.league_season_id = queued.league_season_id AND published.valid_until <= now());
  IF EXISTS (SELECT 1 FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
    AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')) THEN
    PERFORM public.invoke_edge_function('refresh-views');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
  IF COALESCE(p_params->>'operation', 'claim') = 'claim' THEN
    WITH candidates AS (
      SELECT league_season_id FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')
      ORDER BY changed_at, league_season_id LIMIT LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 1), 1), 1)
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE private.screen_refresh_queue q SET claimed_at = now(), claim_token = gen_random_uuid(), claimed_version = q.version
      FROM candidates c WHERE q.league_season_id = c.league_season_id RETURNING q.*
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('leagueId', c.league_id, 'seasonId', c.league_season_id,
      'version', c.version, 'claimToken', c.claim_token, 'trades', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('tradeId', trade.id, 'memberId', member.id, 'userId', member.user_id) ORDER BY trade.id)
        FROM (SELECT trade.id, trade.proposer_member_id FROM public.trades trade
          LEFT JOIN private.trade_value_publications cached ON cached.trade_id = trade.id
          WHERE trade.league_season_id = c.league_season_id
            AND (cached.trade_id IS NULL OR cached.version < c.version OR cached.valid_until <= now())
          ORDER BY cached.version NULLS FIRST, trade.id LIMIT 20) trade
        JOIN public.league_members member ON member.id = trade.proposer_member_id), '[]'::jsonb))), '[]'::jsonb) INTO result FROM claimed c;
    RETURN result;
  END IF;
  SELECT * INTO queued FROM private.screen_refresh_queue WHERE league_id = p_league_id
    AND league_season_id = (p_params->>'seasonId')::uuid FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS NULL OR queued.claim_token IS DISTINCT FROM (p_params->>'claimToken')::uuid
    OR queued.claimed_version IS DISTINCT FROM (p_params->>'version')::bigint THEN RETURN 'false'; END IF;
  IF p_params->>'operation' = 'fail' THEN
    UPDATE private.screen_refresh_queue SET claim_token = NULL, claimed_at = NULL, claimed_version = NULL,
      available_at = now() + interval '1 minute', last_error = left(p_params->>'error', 1000) WHERE league_season_id = queued.league_season_id;
    RETURN 'true';
  END IF;
  IF p_params->>'operation' IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'Unknown refresh operation.' USING ERRCODE = '22023'; END IF;
  completed := queued.version = queued.claimed_version;
  IF completed THEN
    PERFORM private.refresh_standings(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_matchup_totals(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_player_averages(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_trade_values(queued.league_id, queued.league_season_id, queued.version, COALESCE(p_params->'tradeValues', '[]'));
    completed := NOT EXISTS (SELECT 1 FROM public.trades trade
      LEFT JOIN private.trade_value_publications cached ON cached.trade_id = trade.id
      WHERE trade.league_season_id = queued.league_season_id
        AND (cached.trade_id IS NULL OR cached.version < queued.version OR cached.valid_until <= now()));
  END IF;
  UPDATE private.screen_refresh_queue SET dirty = NOT completed, claim_token = NULL, claimed_at = NULL,
    claimed_version = NULL, last_error = NULL, available_at = CASE WHEN completed THEN available_at ELSE now() + interval '5 seconds' END WHERE league_season_id = queued.league_season_id;
  RETURN to_jsonb(completed);
END;
$$;

CREATE OR REPLACE FUNCTION public.view_context(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE member public.league_members%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  today date := (now() AT TIME ZONE 'America/New_York')::date; week integer; context_version bigint; dirty boolean;
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
  SELECT q.version, q.dirty INTO context_version, dirty FROM private.screen_refresh_queue q WHERE q.league_season_id = season.id;
  RETURN jsonb_build_object('leagueId', p_league_id, 'memberId', p_member_id, 'league', to_jsonb(league),
    'member', to_jsonb(member), 'season', CASE WHEN season.id IS NULL THEN NULL ELSE to_jsonb(season) END,
    'seasonId', season.id, 'seasonYear', COALESCE((p_params->>'seasonYear')::integer, season.season_year, public.current_season_year_et()),
    'weekNumber', COALESCE((p_params->>'weekNumber')::integer, week), 'today', today,
    'pendingIncomingCount', public.get_pending_trade_count(p_member_id, p_league_id),
    'version', context_version, 'stale', COALESCE(dirty, true))
    || CASE WHEN p_params ? 'tradeId' THEN jsonb_build_object('tradeAnalysisStale',
      CASE WHEN private.can_read_trade((p_params->>'tradeId')::uuid) THEN
        COALESCE((SELECT published.valid_until<=now() OR published.version IS DISTINCT FROM context_version
          FROM private.trade_value_publications published JOIN public.trades trade ON trade.id=published.trade_id
          WHERE trade.id=(p_params->>'tradeId')::uuid AND trade.league_id=p_league_id
            AND trade.league_season_id=season.id),true) OR COALESCE(dirty,true)
      ELSE true END) ELSE '{}'::jsonb END;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_trade_details(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; trade public.trades%ROWTYPE; participants jsonb; items jsonb; estimate jsonb; unavailable text; result jsonb; analysis_context jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO trade FROM public.trades WHERE id = (p_params->>'tradeId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'trade', NULL, 'analysis', NULL); END IF;
  analysis_context := public.view_context(p_league_id, p_member_id, jsonb_build_object('seasonId', trade.league_season_id,'tradeId',trade.id));
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
    'analysisStale', COALESCE((analysis_context->>'tradeAnalysisStale')::boolean,true));
END;
$$;

RESET statement_timeout;
RESET lock_timeout;
