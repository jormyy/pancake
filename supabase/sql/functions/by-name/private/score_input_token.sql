-- Canonical SQL source for private.score_input_token.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.score_input_token(p_season_id uuid, p_week int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN count(*) > 0 AND bool_and(revision IS NOT NULL)
    THEN jsonb_object_agg(keys.scope, revision::text) ELSE NULL END
  FROM private.score_input_keys(p_season_id, p_week) keys
  LEFT JOIN private.score_input_revisions revision ON revision.scope = keys.scope;
$$;
