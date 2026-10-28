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
