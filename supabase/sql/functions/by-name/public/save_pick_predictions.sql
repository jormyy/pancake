-- Canonical SQL source for public.save_pick_predictions.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.save_pick_predictions(p_league_id uuid,p_rows jsonb,p_source_version text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE updated integer;
BEGIN
  PERFORM 1 FROM private.trade_value_sync_state WHERE id AND content_sha256=p_source_version FOR SHARE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) row
    WHERE jsonb_typeof(row->'value') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row->'odds'->'early') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row->'odds'->'mid') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row->'odds'->'late') IS DISTINCT FROM 'number'
      OR (row->>'value')::numeric<LEAST((row->'bands'->>'early')::numeric,(row->'bands'->>'mid')::numeric,(row->'bands'->>'late')::numeric)-0.000001
      OR (row->>'value')::numeric>GREATEST((row->'bands'->>'early')::numeric,(row->'bands'->>'mid')::numeric,(row->'bands'->>'late')::numeric)+0.000001
      OR abs((row->'odds'->>'early')::numeric+(row->'odds'->>'mid')::numeric+(row->'odds'->>'late')::numeric-1)>0.000001) THEN
    RAISE EXCEPTION 'Invalid predicted pick values or odds.' USING ERRCODE='22023';
  END IF;
  UPDATE public.draft_picks pick SET predicted_tier_odds=row->'odds',predicted_trade_value=(row->>'value')::numeric,
    predicted_value_bands=row->'bands',prediction_details=row->'details',prediction_version='pick-finish-v1',
    predicted_at=now(),prediction_source_sha256=p_source_version
    FROM jsonb_array_elements(p_rows) row WHERE pick.id=(row->>'id')::uuid AND pick.league_id=p_league_id;
  GET DIAGNOSTICS updated=ROW_COUNT;
  RETURN updated;
END;
$$;
