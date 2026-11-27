-- Canonical SQL source for private.rookie_class_status.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rookie_class_status(p_draft_year int)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH import AS (
    SELECT * FROM public.nba_draft_class_imports WHERE draft_year = p_draft_year
  ),
  reconciled AS (
    SELECT * FROM private.rookie_class_reconciliation(p_draft_year)
  )
  SELECT jsonb_build_object(
    'draftYear', p_draft_year,
    'state', CASE
      WHEN (SELECT board_stored_at FROM import) IS NULL AND (SELECT last_error FROM import) IS NOT NULL THEN 'failed'
      WHEN (SELECT board_stored_at FROM import) IS NULL THEN 'not_imported'
      WHEN EXISTS (SELECT 1 FROM reconciled WHERE outcome <> 'eligible') THEN 'incomplete'
      ELSE 'complete'
    END,
    'officialCount', COALESCE((SELECT jsonb_array_length(official_picks) FROM import), 0),
    'eligibleCount', (SELECT count(*) FROM private.rookie_class_players(p_draft_year)),
    'lastError', (SELECT last_error FROM import),
    'lastAttemptAt', (SELECT last_attempt_at FROM import),
    'boardStoredAt', (SELECT board_stored_at FROM import),
    'discrepancies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('overallPick', overall_pick, 'officialName', official_name,
        'personId', official_person_id, 'playerName', player_name, 'outcome', outcome) ORDER BY overall_pick)
        FROM reconciled WHERE outcome <> 'eligible'), '[]'::jsonb)
  )
$$;
