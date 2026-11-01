-- Canonical SQL source for public.view_refresh_work.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
  IF p_params->>'operation'='begin-trade' THEN
    RETURN to_jsonb(private.begin_trade_revaluation((p_params->>'tradeId')::uuid,p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='check-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      private.trade_revaluation_input_version((p_params->>'tradeId')::uuid),p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='trade-ready' THEN
    RETURN to_jsonb(EXISTS(SELECT 1 FROM public.trades trade WHERE trade.id=(p_params->>'tradeId')::uuid
      AND trade.status IN ('pending','accepted') AND NOT EXISTS(SELECT 1 FROM private.trade_value_publications published
        WHERE published.trade_id=trade.id AND published.input_fingerprint=p_params->>'inputFingerprint'
          AND published.model_version=p_params->>'modelVersion')));
  END IF;
  IF p_params->>'operation'='queue-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      p_params->>'inputFingerprint',p_params->>'modelVersion',p_params->'inputs'));
  END IF;
  IF p_params->>'operation'='queue-trades' THEN
    RETURN private.refresh_queue_trade_revaluations((p_params->>'seasonId')::uuid,
      (p_params->>'version')::bigint,p_params->>'modelVersion',(p_params->>'after')::uuid);
  END IF;
  IF p_params->>'operation'='publish-trade' THEN
    RETURN to_jsonb(private.refresh_trade_values(p_league_id,(p_params->>'seasonId')::uuid,
      (SELECT version FROM private.screen_refresh_queue WHERE league_season_id=(p_params->>'seasonId')::uuid),
      jsonb_build_array(jsonb_build_object('tradeId',p_params->>'tradeId','revaluation',p_params->'revaluation'))));
  END IF;
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
      'version', c.version, 'claimToken', c.claim_token)), '[]'::jsonb) INTO result FROM claimed c;
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
    IF queued.standings_dirty THEN
      PERFORM private.refresh_standings(queued.league_id, queued.league_season_id, queued.version);
    END IF;
    PERFORM private.refresh_matchup_totals(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_player_averages(queued.league_id, queued.league_season_id, queued.version);
  END IF;
  UPDATE private.screen_refresh_queue SET dirty = NOT completed, claim_token = NULL, claimed_at = NULL,
    claimed_version = NULL, last_error = NULL,
    standings_dirty=CASE WHEN completed THEN false ELSE standings_dirty END,
    last_refreshed_at=CASE WHEN completed THEN now() ELSE last_refreshed_at END,
    available_at=now()+interval '2 minutes' WHERE league_season_id = queued.league_season_id;
  RETURN to_jsonb(completed);
END;
$$;
