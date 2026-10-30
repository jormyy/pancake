-- Canonical SQL source for private.refresh_queue_trade_revaluations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluations(p_season_id uuid,p_version bigint,p_model text,p_after uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued integer:=0; selected_league uuid; source_version text; fingerprints jsonb;
BEGIN
  PERFORM private.compact_trade_input_revisions();
  SELECT league_id INTO selected_league FROM public.league_seasons WHERE id=p_season_id;
  WITH inputs AS MATERIALIZED (
    SELECT input.* FROM private.trade_revaluation_input_versions(selected_league) input JOIN public.trades trade ON trade.id=input.trade_id
    WHERE trade.league_season_id=p_season_id
  )
  SELECT count(*) FILTER (WHERE (p_after IS NULL OR input.trade_id>p_after)
      AND private.refresh_queue_trade_revaluation(input.trade_id,input.input_version,p_model)),
    COALESCE(jsonb_object_agg(input.trade_id,input.input_version),'{}'),private.trade_revaluation_source_version(p_season_id)
    INTO queued,fingerprints,source_version FROM inputs input;
  IF source_version IS NOT NULL AND p_model IS NOT NULL THEN
    INSERT INTO private.trade_revaluation_scans AS stored(league_season_id,source_version,model_version,next_change_at,fingerprints)
      VALUES(p_season_id,source_version,p_model,private.trade_revaluation_next_change(),fingerprints)
    ON CONFLICT(league_season_id) DO UPDATE SET source_version=EXCLUDED.source_version,model_version=EXCLUDED.model_version,
      next_change_at=EXCLUDED.next_change_at,fingerprints=EXCLUDED.fingerprints;
  ELSE
    DELETE FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
  END IF;
  RETURN jsonb_build_object('queued',queued);
END;
$$;
