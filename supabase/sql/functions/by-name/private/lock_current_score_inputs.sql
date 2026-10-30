-- Canonical SQL source for private.lock_current_score_inputs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lock_current_score_inputs(p_season_id uuid, p_week int, p_token jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_season_id) THEN RETURN false; END IF;
  IF p_token IS NULL OR jsonb_typeof(p_token) <> 'object' THEN RETURN false; END IF;
  PERFORM private.assert_score_game_identity(p_season_id,p_week);
  -- Input writers update these same rows through commit. A conflicting writer
  -- defers scoring or advancement; it cannot commit between validation and use.
  BEGIN
    PERFORM 1 FROM private.score_input_revisions revision
      JOIN private.score_input_keys(p_season_id, p_week) keys USING(scope)
      ORDER BY revision.scope FOR SHARE OF revision NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RETURN false;
  END;
  RETURN p_token IS NOT DISTINCT FROM private.score_input_token(p_season_id, p_week);
END;
$$;
