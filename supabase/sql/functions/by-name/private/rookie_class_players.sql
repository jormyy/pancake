-- Canonical SQL source for private.rookie_class_players.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rookie_class_players(p_draft_year int)
RETURNS TABLE (player_id uuid, draft_round int, draft_overall_pick int)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH stored AS (
    SELECT player.id, player.nba_id, player.draft_round::int AS draft_round, player.draft_overall_pick::int AS draft_overall_pick,
           CASE WHEN player.draft_overall_pick IS NULL THEN 1 ELSE count(*) OVER (PARTITION BY player.draft_overall_pick) END AS same_slot
      FROM public.players player
     WHERE player.draft_status = 'drafted' AND player.draft_year = p_draft_year
  ),
  official AS (
    SELECT (pick->>'overallPick')::int AS overall_pick, (pick->>'round')::int AS draft_round,
           pick->>'personId' AS person_id, private.rookie_name_key(pick->>'playerName') AS name_key
      FROM public.nba_draft_class_imports import, jsonb_array_elements(import.official_picks) pick
     WHERE import.draft_year = p_draft_year AND import.board_stored_at IS NOT NULL
  ),
  confirmed AS (
    SELECT official.overall_pick, official.draft_round, min(candidate.id::text)::uuid AS id
      FROM official
      JOIN public.players candidate
        ON candidate.nba_id IS NOT NULL
       AND candidate.draft_status IS NULL
       AND candidate.draft_year IS NULL
       AND candidate.draft_overall_pick IS NULL
       AND candidate.nba_draft_number = official.overall_pick
       AND CASE WHEN official.person_id IS NOT NULL THEN candidate.nba_id = official.person_id
                ELSE private.rookie_name_key(candidate.display_name) = official.name_key END
     WHERE NOT EXISTS (SELECT 1 FROM stored WHERE stored.draft_overall_pick = official.overall_pick)
     GROUP BY official.overall_pick, official.draft_round
    HAVING count(*) = 1
  )
  SELECT stored.id, stored.draft_round, stored.draft_overall_pick
    FROM stored
   WHERE stored.nba_id IS NOT NULL AND stored.same_slot = 1
  UNION ALL
  SELECT confirmed.id, confirmed.draft_round, confirmed.overall_pick
    FROM confirmed
$$;
