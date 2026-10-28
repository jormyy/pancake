CREATE TABLE public.league_share_tokens (
  league_id uuid PRIMARY KEY REFERENCES public.leagues(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  window_started_at timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  window_reads integer NOT NULL DEFAULT 0 CHECK (window_reads >= 0)
);
CREATE TABLE public.public_read_log (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  resource text NOT NULL CHECK (resource IN ('league','standings','rosters','matchups','scores','schedule','transactions','draft-results','player-stats','projections')),
  reads bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (league_id, hour, resource)
);
CREATE INDEX public_read_log_retention ON public.public_read_log(hour);
ALTER TABLE public.league_share_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_read_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_share_tokens, public.public_read_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.league_share_tokens, public.public_read_log TO service_role;

CREATE OR REPLACE FUNCTION public.public_share_token(p_league_id uuid, p_action text DEFAULT 'create')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE share text;
BEGIN
  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only a commissioner can manage public sharing.' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('create', 'rotate', 'revoke') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Unknown sharing action.' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_league_id::text, 9182));
  IF p_action = 'revoke' THEN
    UPDATE public.league_share_tokens SET revoked_at = now() WHERE league_id = p_league_id;
    RETURN jsonb_build_object('enabled', false);
  END IF;
  IF p_action = 'create' AND EXISTS (SELECT 1 FROM public.league_share_tokens WHERE league_id = p_league_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Sharing already exists. Rotate to replace the token.' USING ERRCODE = '22023';
  END IF;
  share := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.league_share_tokens(league_id, token_hash)
  VALUES (p_league_id, encode(extensions.digest(share, 'sha256'), 'hex'))
  ON CONFLICT (league_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL, created_at = now(),
    window_started_at = date_trunc('minute', now()), window_reads = 0;
  RETURN jsonb_build_object('enabled', true, 'token', share);
END;
$$;

CREATE OR REPLACE FUNCTION public.public_prune_read_log()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '1s' AS $$
DECLARE removed integer;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(9182, 17) THEN RETURN 0; END IF;
  WITH expired AS (
    SELECT ctid FROM public.public_read_log WHERE hour < date_trunc('hour', now()) - interval '7 days'
    ORDER BY hour LIMIT 10000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.public_read_log WHERE ctid IN (SELECT ctid FROM expired);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION public.public_read(p_token text, p_resource text, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '1s' AS $$
DECLARE
  share public.league_share_tokens%ROWTYPE;
  member public.league_members%ROWTYPE;
  context jsonb;
  payload jsonb;
  rows jsonb := '[]';
  item jsonb;
  room jsonb;
  params jsonb := COALESCE(p_params, '{}');
  page_limit integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 25), 1), 50);
  page_offset integer := GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0);
  selected_season uuid;
  previous_sub text := current_setting('request.jwt.claim.sub', true);
  previous_claims text := current_setting('request.jwt.claims', true);
  more boolean := false;
  status integer := 200;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status', 401); END IF;
  SELECT token.* INTO share FROM public.league_share_tokens token JOIN public.leagues league ON league.id = token.league_id
    AND league.deleted_at IS NULL WHERE token.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND token.revoked_at IS NULL FOR UPDATE OF token;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 401); END IF;
  UPDATE public.league_share_tokens SET window_started_at = date_trunc('minute', now()),
    window_reads = CASE WHEN share.window_started_at = date_trunc('minute', now()) THEN LEAST(share.window_reads + 1, 100000) ELSE 1 END
    WHERE league_id = share.league_id RETURNING * INTO share;
  IF p_resource NOT IN ('league','standings','rosters','matchups','scores','schedule','transactions','draft-results','player-stats','projections') THEN
    RETURN jsonb_build_object('status', 404);
  END IF;
  DELETE FROM public.public_read_log WHERE league_id = share.league_id AND hour < date_trunc('hour', now()) - interval '7 days';
  INSERT INTO public.public_read_log(league_id, hour, resource, reads, rejected)
    VALUES (share.league_id, date_trunc('hour', now()), p_resource, 1, CASE WHEN share.window_reads > 60 THEN 1 ELSE 0 END)
    ON CONFLICT (league_id, hour, resource) DO UPDATE SET reads = public.public_read_log.reads + 1,
      rejected = public.public_read_log.rejected + EXCLUDED.rejected;
  IF share.window_reads > 60 THEN RETURN jsonb_build_object('status', 429,
    'retryAfter', GREATEST(1, ceil(extract(epoch FROM date_trunc('minute', now()) + interval '1 minute' - now())))); END IF;
  SELECT * INTO member FROM public.league_members WHERE league_id = share.league_id
    ORDER BY CASE WHEN role = 'commissioner' THEN 0 ELSE 1 END, id LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 404); END IF;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', member.user_id::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', member.user_id, 'role', 'authenticated')::text, true);
    SELECT id INTO selected_season FROM public.league_seasons WHERE league_id = share.league_id
      AND (params->>'seasonYear' IS NULL OR season_year = (params->>'seasonYear')::integer)
      ORDER BY is_current DESC, season_year DESC, id LIMIT 1;
    IF selected_season IS NULL THEN
      status := 404;
    ELSE
      params := params || jsonb_build_object('seasonId', selected_season);
      context := public.view_context(share.league_id, member.id, params);
      CASE p_resource
      WHEN 'league' THEN
        payload := public.view_settings(share.league_id, member.id, params);
        rows := jsonb_build_array(jsonb_build_object('id', share.league_id, 'name', payload->'league'->'name',
          'seasonId', selected_season, 'seasonYear', context->'seasonYear', 'weekNumber', context->'weekNumber',
          'timezone', payload->'league'->'timezone', 'scoringSettings', payload->'league'->'scoring_settings'));
      WHEN 'standings' THEN
        payload := public.view_standings(share.league_id, member.id, params);
        SELECT COALESCE(jsonb_agg(jsonb_build_object('teamId', row->'memberId', 'teamName', row->'teamName', 'rank', ordinal,
          'wins', row->'wins', 'losses', row->'losses', 'ties', row->'ties', 'pointsFor', row->'pointsFor',
          'pointsAgainst', row->'pointsAgainst', 'maxPointsFor', row->'maxPointsFor') ORDER BY ordinal), '[]') INTO rows
          FROM jsonb_array_elements(payload->'standings') WITH ORDINALITY entries(row, ordinal)
          WHERE params->>'targetMemberId' IS NULL OR row->>'memberId' = params->>'targetMemberId';
      WHEN 'rosters' THEN
        IF params->>'targetMemberId' IS NULL THEN RAISE EXCEPTION 'Team required.' USING ERRCODE = '22023'; END IF;
        payload := public.view_roster(share.league_id, member.id, params);
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', row->'id', 'teamId', params->'targetMemberId',
          'isOnIR', row->'is_on_ir', 'isOnTaxi', row->'is_on_taxi', 'player', jsonb_build_object(
          'id', row->'players'->'id', 'name', row->'players'->'display_name', 'nbaTeam', row->'players'->'nba_team',
          'position', row->'players'->'position', 'injuryStatus', row->'players'->'injury_status')) ORDER BY row->>'id'), '[]') INTO rows
          FROM jsonb_array_elements(payload->'roster') row;
      WHEN 'matchups', 'scores', 'schedule' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'seasonId', league_season_id, 'weekNumber', week_number,
          'endWeekNumber', COALESCE(end_week_number, week_number), 'homeTeamId', home_member_id, 'awayTeamId', away_member_id,
          'homeTeamName', home_team_name, 'awayTeamName', away_team_name, 'homePoints', home_points, 'awayPoints', away_points,
          'finalized', is_finalized, 'winnerTeamId', winner_member_id) ORDER BY week_number, id), '[]') INTO rows
        FROM (SELECT id, league_season_id, week_number, end_week_number, home_member_id, away_member_id,
          home_team_name, away_team_name, home_points, away_points, is_finalized, winner_member_id
          FROM public.v_matchup_detail WHERE league_id = share.league_id AND league_season_id = selected_season AND NOT is_voided
          AND (params->>'weekNumber' IS NULL OR (params->>'weekNumber')::integer BETWEEN week_number AND COALESCE(end_week_number, week_number))
          AND (params->>'targetMemberId' IS NULL OR (params->>'targetMemberId')::uuid IN (home_member_id, away_member_id))
          ORDER BY week_number, id LIMIT page_limit + 1 OFFSET page_offset) selected;
      WHEN 'transactions' THEN
        payload := public.view_activity(share.league_id, member.id, params);
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', row->'id', 'teamId', row->'memberId', 'teamName', row->'teamName',
          'playerId', row->'playerId', 'playerName', row->'playerName', 'type', row->'transactionType',
          'occurredAt', row->'occurredAt', 'targetTeamName', row->'targetTeamName') ORDER BY row->>'occurredAt' DESC, row->>'id' DESC), '[]') INTO rows
          FROM jsonb_array_elements(payload->'rows') row
          WHERE row->>'transactionType' IN ('fa_add','fa_drop','waiver_add','waiver_drop','trade_in','trade_out','draft_won','carry_over','trade_completed')
          AND (params->>'targetMemberId' IS NULL OR row->>'memberId' = params->>'targetMemberId');
        more := COALESCE((payload->>'hasMore')::boolean, false);
      WHEN 'draft-results' THEN
        payload := public.view_draft_rooms(share.league_id, member.id, params);
        FOR room IN SELECT value FROM jsonb_array_elements(payload->'drafts') WHERE value->>'status' = 'completed' ORDER BY value->>'id' LOOP
          payload := public.view_draft_room(share.league_id, member.id, params || jsonb_build_object('draftId', room->'id'));
          IF room->>'draft_type' = 'snake' THEN
            FOR item IN SELECT value FROM jsonb_array_elements(payload->'picks') WHERE value->>'player' IS NOT NULL ORDER BY (value->>'overallPick')::integer LOOP
              rows := rows || jsonb_build_array(jsonb_build_object('id', (room->>'id') || ':' || (item->>'overallPick'),
                'draftId', room->'id', 'draftType', 'snake', 'overallPick', item->'overallPick', 'round', item->'round',
                'teamId', item->'memberId', 'teamName', item->'teamName', 'pickedAt', item->'pickedAt', 'price', NULL,
                'player', jsonb_build_object('id', item->'player'->'id', 'name', item->'player'->'displayName',
                  'nbaTeam', item->'player'->'nbaTeam', 'position', item->'player'->'position', 'injuryStatus', item->'player'->'injuryStatus')));
            END LOOP;
          ELSE
            FOR item IN SELECT value FROM jsonb_array_elements(payload->'nominations') WHERE value->>'status' = 'sold' ORDER BY (value->>'nominationOrder')::integer LOOP
              rows := rows || jsonb_build_array(jsonb_build_object('id', item->'id', 'draftId', room->'id', 'draftType', 'auction',
                'overallPick', item->'nominationOrder', 'round', NULL, 'teamId', item->'winningMemberId',
                'teamName', (SELECT value->'teamName' FROM jsonb_array_elements(payload->'order') WHERE value->>'memberId' = item->>'winningMemberId'),
                'pickedAt', item->'nominatedAt', 'price', item->'finalPrice', 'player', jsonb_build_object('id', NULL,
                  'name', item->'player'->'displayName', 'nbaTeam', item->'player'->'nbaTeam',
                  'position', item->'player'->'position', 'injuryStatus', item->'player'->'injuryStatus')));
            END LOOP;
          END IF;
        END LOOP;
      WHEN 'player-stats', 'projections' THEN
        IF params->>'playerId' IS NOT NULL THEN params := params || jsonb_build_object('includePlayerIds', jsonb_build_array(params->'playerId')); END IF;
        payload := public.view_players(share.league_id, member.id, params || jsonb_build_object('sortBy', 'name', 'sortDir', 'asc'));
        SELECT COALESCE(jsonb_agg(CASE WHEN p_resource = 'player-stats' THEN jsonb_build_object('id', row->'id',
          'name', row->'display_name', 'nbaTeam', row->'nba_team', 'position', row->'position', 'seasonYear', row->'stats_season_year',
          'gamesPlayed', row->'games_played', 'fantasyPoints', row->'avg_fantasy_points', 'points', row->'avg_points',
          'rebounds', row->'avg_rebounds', 'assists', row->'avg_assists', 'steals', row->'avg_steals', 'blocks', row->'avg_blocks',
          'turnovers', row->'avg_turnovers', 'minutes', row->'avg_minutes_played') ELSE jsonb_build_object('id', row->'id',
          'name', row->'display_name', 'nbaTeam', row->'nba_team', 'position', row->'position', 'date', row->'projection_date',
          'source', row->'projection_source', 'fetchedAt', row->'projection_fetched_at', 'status', row->'projection_status',
          'fantasyPoints', row->'projection_fantasy_points', 'points', row->'projection_points', 'rebounds', row->'projection_rebounds',
          'assists', row->'projection_assists', 'steals', row->'projection_steals', 'blocks', row->'projection_blocks',
          'turnovers', row->'projection_turnovers', 'minutes', row->'projection_minutes') END ORDER BY ordinal), '[]') INTO rows
          FROM jsonb_array_elements(payload->'players') WITH ORDINALITY entries(row, ordinal);
        more := COALESCE((payload->>'hasMore')::boolean, false);
      END CASE;
      IF p_resource NOT IN ('transactions','player-stats','projections') THEN
        IF p_resource IN ('matchups','scores','schedule') THEN page_offset := 0; END IF;
        more := jsonb_array_length(rows) > page_offset + page_limit;
        SELECT COALESCE(jsonb_agg(value ORDER BY ordinal), '[]') INTO rows
          FROM jsonb_array_elements(rows) WITH ORDINALITY entries(value, ordinal)
          WHERE ordinal > page_offset AND ordinal <= page_offset + page_limit;
      END IF;
    END IF;
  EXCEPTION WHEN insufficient_privilege OR invalid_text_representation OR invalid_parameter_value THEN status := 400;
    WHEN OTHERS THEN status := 503;
  END;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(previous_sub, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(previous_claims, '{}'), true);
  IF status <> 200 THEN
    UPDATE public.public_read_log SET rejected = rejected + 1
      WHERE league_id = share.league_id AND hour = date_trunc('hour', now()) AND resource = p_resource;
  END IF;
  RETURN jsonb_build_object('status', status, 'items', rows, 'hasMore', more);
END;
$$;

REVOKE ALL ON FUNCTION public.public_share_token(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.public_share_token(uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.public_read(text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_read(text,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.public_prune_read_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_prune_read_log() TO service_role;
SELECT cron.schedule('public-read-retention', '17 * * * *', 'SELECT public.public_prune_read_log()');
