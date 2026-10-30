-- Canonical SQL source for public.get_trade_revaluation_inputs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_trade_revaluation_inputs(p_user_id uuid,p_member_id uuid,p_trade_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  terms jsonb; inputs jsonb; fingerprint text;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
  allowed boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.trades t JOIN public.league_members m ON m.league_id=t.league_id
    JOIN public.leagues l ON l.id=t.league_id AND l.deleted_at IS NULL
    WHERE t.id=p_trade_id AND m.id=p_member_id AND m.user_id=p_user_id) THEN
    RAISE EXCEPTION 'This trade is not available for revaluation.' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
  allowed:=private.can_read_trade(p_trade_id);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  IF NOT allowed THEN
    RAISE EXCEPTION 'This trade is not available for revaluation.' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.trades WHERE id=p_trade_id AND status IN ('pending','accepted')) THEN
    RETURN jsonb_build_object('closed',true,'revaluationTradeId',p_trade_id,'cachedRevaluation',
      COALESCE((SELECT revaluation||jsonb_build_object('expiresAt',now()+interval '10 minutes')
        FROM public.trade_value_cache WHERE trade_id=p_trade_id AND revaluation->>'modelVersion'='onenumber-trade-curve-v5'),
        (SELECT jsonb_build_object('tradeId',p_trade_id,'analysis',quote.analysis,'modelVersion',quote.model_version,
          'inputVersion',quote.input_version,'createdAt',quote.created_at,'expiresAt',now()+interval '10 minutes',
          'seasonYear',quote.inputs->'seasonYear') FROM public.trade_estimates recorded
          JOIN public.trade_estimate_quotes quote ON quote.id=recorded.quote_id WHERE recorded.trade_id=p_trade_id
            AND quote.model_version='onenumber-trade-curve-v5')));
  END IF;
  fingerprint:=private.trade_revaluation_input_version(p_trade_id);
  SELECT jsonb_agg(jsonb_build_object('fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,
    'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount) ORDER BY i.id)
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  inputs:=private.build_trade_estimate_inputs(p_user_id,p_member_id,terms,false)
    ||jsonb_build_object('revaluationTradeId',p_trade_id,'pickPredictionVersions',(
      SELECT jsonb_agg(jsonb_build_array(pick.id,pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.trade_items item ON item.pick_id=pick.id WHERE item.trade_id=p_trade_id));
  inputs:=inputs||jsonb_build_object('playerDestinations',(
    SELECT COALESCE(jsonb_object_agg(item.player_id::text,CASE WHEN item.to_taxi THEN 'taxi' WHEN item.to_ir THEN 'ir' ELSE
      CASE WHEN EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=(inputs->>'seasonId')::uuid
        AND roster.player_id=item.player_id AND roster.is_on_taxi) THEN 'taxi' ELSE 'active' END END),'{}'::jsonb)
    FROM public.trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL));
  inputs:=inputs||jsonb_build_object('valuationFreshness',(
    SELECT jsonb_agg(jsonb_build_array(player->>'player_id',
      (player->>'ranking_fetched_at')::timestamptz BETWEEN now()-interval '90 days' AND now(),
      player->>'projection_source'='season_avg' OR (player->>'projection_fetched_at')::timestamptz
        BETWEEN now()-CASE WHEN player->>'projection_source'='internal' THEN interval '8 days' ELSE interval '36 hours' END AND now())
      ORDER BY player->>'player_id')
    FROM jsonb_array_elements((inputs->'players')||(inputs->'replacementPlayers')) player));
  IF fingerprint IS DISTINCT FROM private.trade_revaluation_input_version(p_trade_id) THEN
    RAISE EXCEPTION 'Trade inputs changed. Retry.' USING ERRCODE='40001';
  END IF;
  RETURN inputs||jsonb_build_object('inputVersion',fingerprint,'observedAt',now(),'cachedRevaluation',
    (SELECT cached.revaluation||jsonb_build_object('expiresAt',now()+interval '10 minutes')
      FROM private.trade_value_publications published
      JOIN public.trade_value_cache cached USING(trade_id)
      WHERE published.trade_id=p_trade_id AND published.input_fingerprint=fingerprint));
END;
$$;
