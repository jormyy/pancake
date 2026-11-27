-- Canonical SQL source for private.rookie_draft_pool.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rookie_draft_pool(p_draft_id uuid)
RETURNS TABLE (player_id uuid, draft_round int, draft_overall_pick int)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT class.player_id, class.draft_round, class.draft_overall_pick
    FROM public.drafts draft
    CROSS JOIN LATERAL private.rookie_class_players(private.draft_class_year(draft.id)) class
   WHERE draft.id = p_draft_id
     AND NOT EXISTS (SELECT 1 FROM public.snake_draft_picks picked WHERE picked.draft_id = draft.id AND picked.player_id = class.player_id)
     AND (draft.is_mock OR NOT EXISTS (
       SELECT 1 FROM public.roster_players roster
        WHERE roster.league_id = draft.league_id AND roster.league_season_id = draft.league_season_id
          AND roster.player_id = class.player_id))
$$;
