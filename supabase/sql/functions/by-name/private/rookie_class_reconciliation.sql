-- Canonical SQL source for private.rookie_class_reconciliation.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rookie_class_reconciliation(p_draft_year int)
RETURNS TABLE (overall_pick int, official_name text, official_person_id text, player_id uuid, player_nba_id text, player_name text, outcome text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH official AS (
    SELECT (pick->>'overallPick')::int AS overall_pick, pick->>'playerName' AS official_name, pick->>'personId' AS person_id
      FROM public.nba_draft_class_imports import, jsonb_array_elements(import.official_picks) pick
     WHERE import.draft_year = p_draft_year
  ),
  stored AS (
    SELECT player.id, player.nba_id, player.display_name, player.draft_year, player.draft_overall_pick,
           count(*) OVER (PARTITION BY player.draft_year, player.draft_overall_pick) AS same_slot
      FROM public.players player
     WHERE player.draft_status = 'drafted' AND player.draft_year = p_draft_year
  ),
  by_person AS (
    SELECT official.overall_pick, player.id, player.nba_id, player.display_name, player.draft_year, player.draft_overall_pick
      FROM official
      CROSS JOIN LATERAL (
        SELECT candidate.id, candidate.nba_id, candidate.display_name, candidate.draft_year, candidate.draft_overall_pick
          FROM public.players candidate
         WHERE CASE WHEN official.person_id IS NOT NULL THEN candidate.nba_id = official.person_id
                    ELSE private.rookie_name_key(candidate.display_name) = private.rookie_name_key(official.official_name) END
         ORDER BY candidate.draft_year IS NOT DISTINCT FROM p_draft_year DESC, candidate.draft_year DESC NULLS LAST, candidate.id
         LIMIT 1
      ) player
     WHERE NOT EXISTS (SELECT 1 FROM stored WHERE stored.draft_overall_pick = official.overall_pick)
  )
  SELECT official.overall_pick, official.official_name, official.person_id,
         COALESCE(stored.id, by_person.id), COALESCE(stored.nba_id, by_person.nba_id), COALESCE(stored.display_name, by_person.display_name),
         CASE
           WHEN stored.id IS NOT NULL AND stored.same_slot > 1 THEN 'duplicate'
           WHEN stored.id IS NOT NULL AND CASE WHEN official.person_id IS NOT NULL THEN stored.nba_id IS DISTINCT FROM official.person_id
                ELSE private.rookie_name_key(stored.display_name) IS DISTINCT FROM private.rookie_name_key(official.official_name) END THEN 'identity_mismatch'
           WHEN stored.id IS NOT NULL THEN 'eligible'
           WHEN by_person.id IS NOT NULL AND by_person.draft_year IS DISTINCT FROM p_draft_year THEN 'wrong_year'
           WHEN by_person.id IS NOT NULL THEN 'wrong_pick'
           ELSE 'missing'
         END
    FROM official
    LEFT JOIN stored ON stored.draft_overall_pick = official.overall_pick
    LEFT JOIN by_person ON by_person.overall_pick = official.overall_pick AND stored.id IS NULL
  UNION ALL
  SELECT stored.draft_overall_pick, NULL, NULL, stored.id, stored.nba_id, stored.display_name, 'not_on_official_board'
    FROM stored
   WHERE EXISTS (SELECT 1 FROM official)
     AND NOT EXISTS (SELECT 1 FROM official WHERE official.overall_pick = stored.draft_overall_pick)
$$;
