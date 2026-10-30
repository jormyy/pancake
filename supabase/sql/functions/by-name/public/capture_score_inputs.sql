-- Canonical SQL source for public.capture_score_inputs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.capture_score_inputs(p_league_season_id uuid, p_week_number int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  PERFORM private.assert_score_game_identity(p_league_season_id,p_week_number);
  INSERT INTO private.score_input_revisions(scope, revision)
    SELECT keys.scope, 0 FROM private.score_input_keys(p_league_season_id, p_week_number) keys
    WHERE NOT EXISTS(SELECT 1 FROM private.score_input_revisions revision WHERE revision.scope = keys.scope) ORDER BY keys.scope
    ON CONFLICT(scope) DO NOTHING;
  RETURN private.score_input_token(p_league_season_id, p_week_number);
END;
$$;
