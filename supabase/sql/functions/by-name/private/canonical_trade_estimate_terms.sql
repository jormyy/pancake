CREATE OR REPLACE FUNCTION private.canonical_trade_estimate_terms(p_items jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
    'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
    'faabAmount',COALESCE((item->>'faabAmount')::integer,0))
    ORDER BY item->>'fromMemberId',item->>'toMemberId',item->>'playerId',item->>'pickId',COALESCE((item->>'faabAmount')::integer,0)),
    '[]'::jsonb) FROM jsonb_array_elements(p_items) item;
$$;
