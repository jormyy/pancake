-- Canonical SQL source for private.refresh_trade_values.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_trade_values(p_league_id uuid, p_season_id uuid, p_version bigint, p_values jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE item jsonb; trade record; inputs jsonb; value jsonb; published boolean:=false;
BEGIN
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Trade values must be an array.' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_values) LOOP
    SELECT t.*,m.user_id INTO trade FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
      WHERE t.id=(item->>'tradeId')::uuid AND t.league_id=p_league_id AND t.league_season_id=p_season_id
        AND t.status IN ('pending','accepted') FOR UPDATE OF t;
    IF NOT FOUND THEN CONTINUE; END IF;
    value:=item->'revaluation';
    IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'inputVersion' IS NULL
      OR value->>'modelVersion' IS NULL THEN CONTINUE; END IF;
    inputs:=jsonb_build_object('inputVersion',private.trade_revaluation_input_version(trade.id));
    IF inputs->>'inputVersion' IS DISTINCT FROM value->>'inputVersion' THEN
      PERFORM private.refresh_queue_trade_revaluation(trade.id,inputs->>'inputVersion',value->>'modelVersion');
      CONTINUE;
    END IF;
    IF EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id
      AND input_fingerprint=value->>'inputVersion' AND model_version=value->>'modelVersion') THEN
      published:=true;
      CONTINUE;
    END IF;
    INSERT INTO public.trade_value_cache AS cached(trade_id,league_id,league_season_id,revaluation,valid_until,version)
      VALUES(trade.id,p_league_id,p_season_id,value,'infinity',p_version)
      ON CONFLICT(trade_id) DO UPDATE SET revaluation=EXCLUDED.revaluation,valid_until=EXCLUDED.valid_until,
        version=EXCLUDED.version,refreshed_at=now();
    INSERT INTO private.trade_value_publications(trade_id,version,valid_until,input_fingerprint,model_version)
      VALUES(trade.id,p_version,'infinity',value->>'inputVersion',value->>'modelVersion')
      ON CONFLICT(trade_id) DO UPDATE SET version=EXCLUDED.version,valid_until=EXCLUDED.valid_until,
        input_fingerprint=EXCLUDED.input_fingerprint,model_version=EXCLUDED.model_version;
    published:=true;
  END LOOP;
  RETURN published;
END;
$$;
