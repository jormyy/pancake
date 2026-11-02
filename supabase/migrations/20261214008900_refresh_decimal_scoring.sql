DO $$
DECLARE v_keys text[];
BEGIN
  SELECT array_agg('league:'||league.id ORDER BY league.id) INTO v_keys
  FROM public.leagues league
  WHERE EXISTS(SELECT 1 FROM jsonb_each(league.scoring_settings) setting
      WHERE jsonb_typeof(setting.value)='number' AND scale((setting.value#>>'{}')::numeric)>2)
    AND EXISTS(SELECT 1 FROM public.matchups matchup WHERE matchup.league_id=league.id
      AND NOT matchup.is_voided AND NOT coalesce(matchup.is_finalized,false));
  IF cardinality(v_keys)>0 THEN
    PERFORM private.bump_score_input_revisions(v_keys);
    PERFORM private.work_enqueue('sync-scores','decimal-scoring-v2',now());
  END IF;
END;
$$;
