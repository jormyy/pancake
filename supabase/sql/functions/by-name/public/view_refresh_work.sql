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
